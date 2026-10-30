import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const poller = join(root, 'skills', 'feishu-meeting-attendee', 'scripts', 'poll-and-archive.ts');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'meeting-attendee-test-'));
const fakeCli = join(fixtureRoot, 'fake-lark-cli.ts');

interface PollerResult {
  exitCode: number;
  status: string;
  stdout: string;
  stderr: string;
}

beforeAll(() => {
  writeFileSync(fakeCli, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const mode = process.env.FAKE_MEETING_MODE ?? 'ended';
if (args.includes('+meeting-events')) {
  if (mode === 'slow-success') {
    await Bun.sleep(300);
    console.log(JSON.stringify({ ok: true, data: { events: [] } }));
    process.exit(0);
  }
  if (mode === 'plain-ended') {
    console.error('Error: [122001] meeting status unexpected');
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, data: { events: [] } }));
  process.exit(0);
}
if (args.includes('meeting') && args.includes('get')) {
  const status = mode === 'active' ? 'ongoing' : 'ended';
  console.log(JSON.stringify({ ok: true, data: { meeting: { status, end_time: status === 'ended' ? '1700000000' : undefined } } }));
  process.exit(0);
}
console.error('unexpected fake lark-cli command');
process.exit(2);
`, { mode: 0o700 });
  chmodSync(fakeCli, 0o700);
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

async function runPoller(archiveDir: string, mode: string): Promise<PollerResult> {
  const child = Bun.spawn([
    'bun', poller, 'meeting-test-id',
    '--archive-dir', archiveDir,
    '--assigner-ref', 'ou_test123',
    '--max-polls', '1',
  ], {
    cwd: root,
    env: { ...process.env, FEISHU_MEETING_LARK_CLI: fakeCli, FAKE_MEETING_MODE: mode },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const resultLine = stdout.trim().split('\n').filter(Boolean).at(-1);
  const status = resultLine ? JSON.parse(resultLine).status : 'missing';
  return { exitCode, status, stdout, stderr };
}

function pendingFiles(archiveDir: string): string[] {
  return readdirSync(archiveDir).filter(name => name.startsWith('notification.pending.'));
}

describe('poll-and-archive durable behavior', () => {
  test('four-way stale-lock contention elects exactly one writer in 15 rounds', async () => {
    for (let round = 0; round < 15; round += 1) {
      const archiveDir = join(fixtureRoot, `contention-${round}`);
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, '.poll.lock'), JSON.stringify({ pid: 999_999, ownerToken: 'dead' }) + '\n');

      const results = await Promise.all(Array.from({ length: 4 }, () => runPoller(archiveDir, 'slow-success')));
      expect(results.filter(result => result.status === 'ended')).toHaveLength(1);
      expect(results.filter(result => result.status === 'already_running')).toHaveLength(3);
      expect(results.every(result => result.exitCode === 0)).toBe(true);
      expect(readdirSync(join(archiveDir, 'raw')).filter(name => name.endsWith('.json'))).toHaveLength(1);
      expect(readdirSync(archiveDir).filter(name => name.startsWith('.poll.lock.stale-'))).toHaveLength(1);
      expect(pendingFiles(archiveDir)).toHaveLength(0);
      expect(readdirSync(archiveDir)).not.toContain('.poll.lock');
      expect(readdirSync(archiveDir)).not.toContain('.poll.lock.takeover');
    }
  }, 20_000);

  test('recovers only a torn final ledger line and recognizes a plain-text terminal code', async () => {
    const archiveDir = join(fixtureRoot, 'torn-tail');
    mkdirSync(join(archiveDir, 'raw'), { recursive: true });
    const validRecord = {
      schemaVersion: 1,
      source: 'polling',
      batch: 1,
      receivedAt: new Date(0).toISOString(),
      eventVersionKey: 'event:version',
      event: { type: 'heartbeat' },
    };
    writeFileSync(join(archiveDir, 'events.ndjson'), `${JSON.stringify(validRecord)}\n{"partial":`);
    writeFileSync(join(archiveDir, 'cursor.json'), JSON.stringify({
      schemaVersion: 1,
      committedBatch: 1,
      updatedAt: new Date(0).toISOString(),
      lastSuccessfulPollAt: new Date(0).toISOString(),
    }));

    const result = await runPoller(archiveDir, 'plain-ended');
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('ended');
    expect(readFileSync(join(archiveDir, 'events.ndjson'), 'utf8')).toBe(`${JSON.stringify(validRecord)}\n`);
    expect(readFileSync(join(archiveDir, 'torn-tail.log'), 'utf8')).toContain('torn_tail_truncated');
    const final = JSON.parse(readFileSync(join(archiveDir, 'final.json'), 'utf8'));
    expect(final.coverage.complete).toBe(false);
  });

  test('separate active-meeting incidents persist separate pending notifications', async () => {
    const archiveDir = join(fixtureRoot, 'incidents');
    const first = await runPoller(archiveDir, 'active');
    await Bun.sleep(5);
    const second = await runPoller(archiveDir, 'active');

    expect([first.status, second.status]).toEqual(['action_required', 'action_required']);
    expect([first.exitCode, second.exitCode]).toEqual([1, 1]);
    const pending = pendingFiles(archiveDir);
    expect(pending).toHaveLength(2);
    const payloads = pending.map(name => JSON.parse(readFileSync(join(archiveDir, name), 'utf8')));
    expect(new Set(payloads.map(payload => payload.incidentId)).size).toBe(2);
    expect(new Set(payloads.map(payload => payload.dedupKey)).size).toBe(2);
  });

  test('live guard contention is benign while a dead guard requires intervention', async () => {
    const liveArchive = join(fixtureRoot, 'live-guard');
    const liveGuard = join(liveArchive, '.poll.lock.takeover');
    mkdirSync(liveGuard, { recursive: true });
    writeFileSync(join(liveGuard, 'owner.json'), JSON.stringify({ pid: process.pid, ownerToken: 'live' }));
    const live = await runPoller(liveArchive, 'active');
    expect(live.exitCode).toBe(0);
    expect(live.status).toBe('already_running');
    expect(pendingFiles(liveArchive)).toHaveLength(0);

    const deadArchive = join(fixtureRoot, 'dead-guard');
    const deadGuard = join(deadArchive, '.poll.lock.takeover');
    mkdirSync(deadGuard, { recursive: true });
    writeFileSync(join(deadGuard, 'owner.json'), JSON.stringify({ pid: 999_999, ownerToken: 'dead' }));
    const dead = await runPoller(deadArchive, 'active');
    expect(dead.exitCode).toBe(1);
    expect(dead.status).toBe('action_required');
    expect(pendingFiles(deadArchive)).toHaveLength(1);
  });
});
