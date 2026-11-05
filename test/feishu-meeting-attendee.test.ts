import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const poller = join(root, 'skills', 'feishu-meeting-attendee', 'scripts', 'poll-and-archive.ts');
const joinHelper = join(root, 'skills', 'feishu-meeting-attendee', 'scripts', 'join-and-greet.ts');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'meeting-attendee-test-'));
const fakeCli = join(fixtureRoot, 'fake-lark-cli.ts');
const fakeJoinCli = join(fixtureRoot, 'lark-cli');
const assignmentId = 'assignment-test-1';
const meetingKey = createHash('sha256').update('meeting-test-id').digest('hex').slice(0, 20);

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
  if (mode === 'hang-active') {
    await Bun.sleep(60_000);
    console.log(JSON.stringify({ ok: true, data: { events: [] } }));
    process.exit(0);
  }
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
  const status = mode.includes('active') ? 'ongoing' : 'ended';
  console.log(JSON.stringify({ ok: true, data: { meeting: { status, end_time: status === 'ended' ? '1700000000' : undefined } } }));
  process.exit(0);
}
console.error('unexpected fake lark-cli command');
process.exit(2);
`, { mode: 0o700 });
  chmodSync(fakeCli, 0o700);
  writeFileSync(fakeJoinCli, `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_JOIN_LOG!, JSON.stringify(args) + '\\n');
if (args.includes('+meeting-join')) {
  const path = process.env.FAKE_ASSIGNMENT_FILE!;
  const assignment = JSON.parse(readFileSync(path, 'utf8'));
  if (process.env.FAKE_KEEP_ASSIGNMENT_REVISION !== '1') {
    assignment.revision += 1;
    assignment.mode = 'silent';
  }
  writeFileSync(path, JSON.stringify(assignment) + '\\n');
  console.log(JSON.stringify({ ok: true, data: { meeting: { id: 'meeting-joined-id' } } }));
  process.exit(0);
}
if (args.includes('meeting') && args.includes('get')) {
  const mode = process.env.FAKE_ATTENDANCE_MODE ?? 'present';
  if (mode === 'query-failed') {
    console.error('temporary attendance query failure');
    process.exit(1);
  }
  const assignment = JSON.parse(readFileSync(process.env.FAKE_ASSIGNMENT_FILE!, 'utf8'));
  const participantId = mode === 'absent' ? 'ou_another_bot' : assignment.attendeeBotOpenId;
  console.log(JSON.stringify({
    ok: true,
    data: {
      meeting: {
        id: 'meeting-joined-id',
        meeting_no: '123456789',
        participants: [{
          id: participantId,
          status: 2,
          first_join_time: '1793845037',
          final_leave_time: '0',
        }],
      },
    },
  }));
  process.exit(0);
}
if (args.includes('+meeting-message-send')) {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
console.error('unexpected fake join command');
process.exit(2);
`, { mode: 0o700 });
  chmodSync(fakeJoinCli, 0o700);
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

async function runPoller(
  archiveDir: string,
  mode: string,
  selectedAssignmentId = assignmentId,
  extraArgs: string[] = [],
): Promise<PollerResult> {
  const child = Bun.spawn([
    'bun', poller, 'meeting-test-id',
    '--archive-dir', archiveDir,
    '--assigner-ref', 'ou_test123',
    '--assignment-id', selectedAssignmentId,
    '--max-polls', '1',
    ...extraArgs,
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

function seedArchiveManifest(archiveDir: string, selectedAssignmentId = assignmentId): void {
  mkdirSync(join(archiveDir, 'raw'), { recursive: true });
  writeFileSync(join(archiveDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    meetingKey,
    assignmentId: selectedAssignmentId,
    createdAt: new Date(0).toISOString(),
  }) + '\n');
}

function pendingFiles(archiveDir: string): string[] {
  return readdirSync(archiveDir).filter(name => name.startsWith('notification.pending.'));
}

describe('poll-and-archive durable behavior', () => {
  test('four-way stale-lock contention elects exactly one writer in 15 rounds', async () => {
    for (let round = 0; round < 15; round += 1) {
      const archiveDir = join(fixtureRoot, `contention-${round}`);
      mkdirSync(archiveDir, { recursive: true });
      seedArchiveManifest(archiveDir);
      writeFileSync(join(archiveDir, 'status.json'), JSON.stringify({
        schemaVersion: 1,
        assignmentId,
        meetingKey,
        phase: 'monitoring',
        updatedAt: new Date(0).toISOString(),
      }) + '\n');
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
    seedArchiveManifest(archiveDir);
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

  test('blocks an unknown stale lock until a durable notification is recovered', async () => {
    const archiveDir = join(fixtureRoot, 'stale-lock-recovery');
    seedArchiveManifest(archiveDir);
    const originalLock = JSON.stringify({ pid: 999_999, ownerToken: 'dead' }) + '\n';
    writeFileSync(join(archiveDir, '.poll.lock'), originalLock);

    const recovery = await runPoller(archiveDir, 'plain-ended');
    expect(recovery.exitCode).toBe(1);
    expect(recovery.status).toBe('action_required');
    expect(readFileSync(join(archiveDir, '.poll.lock'), 'utf8')).toBe(originalLock);
    expect(pendingFiles(archiveDir)).toHaveLength(1);
    expect(readdirSync(archiveDir).some(name => name.startsWith('.poll.lock.stale-'))).toBe(false);

    const resumed = await runPoller(archiveDir, 'plain-ended');
    expect(resumed.exitCode).toBe(0);
    expect(resumed.status).toBe('ended');
    expect(readdirSync(archiveDir)).not.toContain('.poll.lock');
    expect(readdirSync(archiveDir).some(name => name.startsWith('.poll.lock.stale-'))).toBe(true);
  });

  test('refuses to reuse an archive for another assignment', async () => {
    const archiveDir = join(fixtureRoot, 'assignment-binding');
    const first = await runPoller(archiveDir, 'plain-ended', 'assignment-alpha');
    expect(first.exitCode).toBe(0);
    const finalBefore = readFileSync(join(archiveDir, 'final.json'), 'utf8');

    const second = await runPoller(archiveDir, 'plain-ended', 'assignment-bravo');
    expect(second.exitCode).toBe(1);
    expect(second.status).toBe('action_required');
    expect(readFileSync(join(archiveDir, 'final.json'), 'utf8')).toBe(finalBefore);
    expect(JSON.parse(readFileSync(join(archiveDir, 'manifest.json'), 'utf8')).assignmentId).toBe('assignment-alpha');
  });

  test('bounds a hung provider call and escalates when the meeting is still active', async () => {
    const archiveDir = join(fixtureRoot, 'provider-timeout');
    const startedAt = Date.now();
    const result = await runPoller(archiveDir, 'hang-active', assignmentId, [
      '--provider-timeout-ms', '1000',
      '--max-consecutive-failures', '1',
    ]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('action_required');
    expect(readFileSync(join(archiveDir, 'errors.ndjson'), 'utf8')).toContain('timed out after 1000ms');
    expect(pendingFiles(archiveDir)).toHaveLength(1);
  }, 10_000);

  test('SIGTERM durably records interruption and releases only its own lock', async () => {
    const archiveDir = join(fixtureRoot, 'signal-interruption');
    const child = Bun.spawn([
      'bun', poller, 'meeting-test-id',
      '--archive-dir', archiveDir,
      '--assigner-ref', 'ou_test123',
      '--assignment-id', assignmentId,
      '--provider-timeout-ms', '30000',
      '--max-polls', '1',
    ], {
      cwd: root,
      env: { ...process.env, FEISHU_MEETING_LARK_CLI: fakeCli, FAKE_MEETING_MODE: 'hang-active' },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const statusPath = join(archiveDir, 'status.json');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(statusPath)
        && JSON.parse(readFileSync(statusPath, 'utf8')).providerCall?.stage === 'meeting-events') break;
      await Bun.sleep(20);
    }
    expect(existsSync(join(archiveDir, '.poll.lock'))).toBe(true);
    child.kill('SIGTERM');
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(143);
    expect(JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1)!).status).toBe('action_required');
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    expect(status.phase).toBe('interrupted');
    expect(status.signal).toBe('SIGTERM');
    expect(status.notificationPersisted).toBe(true);
    expect(pendingFiles(archiveDir)).toHaveLength(1);
    expect(existsSync(join(archiveDir, '.poll.lock'))).toBe(false);
  }, 10_000);
});

describe('join-and-greet assignment revisions', () => {
  test('re-reads a near-start mode change before sending the greeting', () => {
    const assignmentFile = join(fixtureRoot, 'join-assignment.json');
    const archiveDir = join(fixtureRoot, 'join-archive');
    const commandLog = join(fixtureRoot, 'join-commands.ndjson');
    writeFileSync(assignmentFile, JSON.stringify({
      assignmentId: 'assignment-join-1',
      revision: 1,
      meeting: 'https://example.invalid/meeting/123456789',
      assigner: 'ou_assigner123',
      attendeeBotOpenId: 'ou_currentbot123',
      archiveDir,
      mode: 'proxy',
    }) + '\n');
    writeFileSync(commandLog, '');

    const result = Bun.spawnSync([
      'bun', joinHelper, '--assignment-file', assignmentFile,
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
        FAKE_ASSIGNMENT_FILE: assignmentFile,
        FAKE_JOIN_LOG: commandLog,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(output.mode).toBe('silent');
    expect(output.assignmentRevision).toBe(2);
    expect(output.greeted).toBe(false);
    expect(output.attendanceVerified).toBe(true);
    const proof = JSON.parse(readFileSync(join(archiveDir, 'attendance-proof.json'), 'utf8'));
    expect(proof).toMatchObject({
      assignmentId: 'assignment-join-1',
      assignmentRevision: 2,
      meetingId: 'meeting-joined-id',
      meetingNo: '123456789',
      botOpenId: 'ou_currentbot123',
      status: 'joined',
    });
    expect(proof.firstJoinTime).toBe('2026-11-05T02:17:17.000Z');
    const commands = readFileSync(commandLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.some(args => args.includes('+meeting-join'))).toBe(true);
    expect(commands.some(args => args.includes('--with-participants'))).toBe(true);
    expect(commands.some(args => args.includes('+meeting-message-send'))).toBe(false);
  });

  test('persists one deduplicated host-action incident only after the server omits the trusted bot', () => {
    const assignmentFile = join(fixtureRoot, 'join-assignment-absent.json');
    const archiveDir = join(fixtureRoot, 'join-archive-absent');
    const commandLog = join(fixtureRoot, 'join-commands-absent.ndjson');
    writeFileSync(assignmentFile, JSON.stringify({
      assignmentId: 'assignment-join-absent',
      revision: 1,
      meeting: 'https://example.invalid/meeting/123456789',
      assigner: 'ou_assigner123',
      attendeeBotOpenId: 'ou_currentbot123',
      archiveDir,
      mode: 'proxy',
    }) + '\n');
    writeFileSync(commandLog, '');

    const result = Bun.spawnSync([
      'bun', joinHelper, '--assignment-file', assignmentFile,
      '--attendance-timeout-ms', '0', '--attendance-poll-ms', '1',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
        FAKE_ASSIGNMENT_FILE: assignmentFile,
        FAKE_JOIN_LOG: commandLog,
        FAKE_ATTENDANCE_MODE: 'absent',
        FAKE_KEEP_ASSIGNMENT_REVISION: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(4);
    const output = JSON.parse(new TextDecoder().decode(result.stderr));
    expect(output).toMatchObject({
      joined: true,
      greeted: false,
      attendanceVerified: false,
      attendanceClassification: 'not_found',
    });
    expect(existsSync(join(archiveDir, 'attendance-proof.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(archiveDir, 'attendance-check.json'), 'utf8')).status).toBe('not_found');
    expect(pendingFiles(archiveDir)).toHaveLength(1);
    const pending = JSON.parse(readFileSync(join(archiveDir, pendingFiles(archiveDir)[0]), 'utf8'));
    expect(pending.reason).toBe('server_attendance_not_found');
    const retry = Bun.spawnSync([
      'bun', joinHelper, '--assignment-file', assignmentFile,
      '--attendance-timeout-ms', '0', '--attendance-poll-ms', '1',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
        FAKE_ASSIGNMENT_FILE: assignmentFile,
        FAKE_JOIN_LOG: commandLog,
        FAKE_ATTENDANCE_MODE: 'absent',
        FAKE_KEEP_ASSIGNMENT_REVISION: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(retry.exitCode).toBe(4);
    expect(pendingFiles(archiveDir)).toHaveLength(1);
    const commands = readFileSync(commandLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.some(args => args.includes('+meeting-message-send'))).toBe(false);
  });

  test('resolves a stale attendance incident when a later server check verifies the bot', () => {
    const assignmentFile = join(fixtureRoot, 'join-assignment-recovered.json');
    const archiveDir = join(fixtureRoot, 'join-archive-recovered');
    const commandLog = join(fixtureRoot, 'join-commands-recovered.ndjson');
    writeFileSync(assignmentFile, JSON.stringify({
      assignmentId: 'assignment-join-recovered',
      revision: 1,
      meeting: 'https://example.invalid/meeting/123456789',
      assigner: 'ou_assigner123',
      attendeeBotOpenId: 'ou_currentbot123',
      archiveDir,
      mode: 'proxy',
    }) + '\n');
    writeFileSync(commandLog, '');

    const first = Bun.spawnSync([
      'bun', joinHelper, '--assignment-file', assignmentFile,
      '--attendance-timeout-ms', '0', '--attendance-poll-ms', '1',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
        FAKE_ASSIGNMENT_FILE: assignmentFile,
        FAKE_JOIN_LOG: commandLog,
        FAKE_ATTENDANCE_MODE: 'absent',
        FAKE_KEEP_ASSIGNMENT_REVISION: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(first.exitCode).toBe(4);
    expect(pendingFiles(archiveDir)).toHaveLength(1);

    const recovered = Bun.spawnSync([
      'bun', joinHelper, '--assignment-file', assignmentFile,
      '--attendance-timeout-ms', '0', '--attendance-poll-ms', '1',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
        FAKE_ASSIGNMENT_FILE: assignmentFile,
        FAKE_JOIN_LOG: commandLog,
        FAKE_ATTENDANCE_MODE: 'present',
        FAKE_KEEP_ASSIGNMENT_REVISION: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(recovered.exitCode).toBe(0);
    expect(pendingFiles(archiveDir)).toHaveLength(0);
    const resolvedFile = readdirSync(archiveDir).find(name => name.startsWith('notification.resolved.'));
    expect(resolvedFile).toBeDefined();
    const resolved = JSON.parse(readFileSync(join(archiveDir, resolvedFile!), 'utf8'));
    expect(resolved).toMatchObject({
      status: 'resolved',
      reason: 'server_attendance_not_found',
      resolution: 'attendance_verified',
    });
  });

  test('classifies a read failure as internal verification trouble instead of absence', () => {
    const assignmentFile = join(fixtureRoot, 'join-assignment-query-failed.json');
    const archiveDir = join(fixtureRoot, 'join-archive-query-failed');
    const commandLog = join(fixtureRoot, 'join-commands-query-failed.ndjson');
    writeFileSync(assignmentFile, JSON.stringify({
      assignmentId: 'assignment-join-query-failed',
      revision: 1,
      meeting: 'https://example.invalid/meeting/123456789',
      assigner: 'ou_assigner123',
      attendeeBotOpenId: 'ou_currentbot123',
      archiveDir,
      mode: 'proxy',
    }) + '\n');
    writeFileSync(commandLog, '');

    const result = Bun.spawnSync([
      'bun', joinHelper, '--assignment-file', assignmentFile,
      '--attendance-timeout-ms', '0', '--attendance-poll-ms', '1',
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
        FAKE_ASSIGNMENT_FILE: assignmentFile,
        FAKE_JOIN_LOG: commandLog,
        FAKE_ATTENDANCE_MODE: 'query-failed',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(4);
    const output = JSON.parse(new TextDecoder().decode(result.stderr));
    expect(output.attendanceClassification).toBe('query_failed');
    const pending = JSON.parse(readFileSync(join(archiveDir, pendingFiles(archiveDir)[0]), 'utf8'));
    expect(pending.reason).toBe('attendance_verification_query_failed');
  });
});
