import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const poller = join(root, 'skills', 'feishu-meeting-attendee', 'scripts', 'poll-and-archive.ts');
const joinHelper = join(root, 'skills', 'feishu-meeting-attendee', 'scripts', 'join-and-greet.ts');
const supervisor = join(root, 'skills', 'feishu-meeting-attendee', 'scripts', 'supervisor-tick.ts');
const assignmentSchema = join(root, 'skills', 'feishu-meeting-attendee', 'references', 'assignment-schema.json');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'meeting-attendee-test-'));
const fakeCli = join(fixtureRoot, 'fake-lark-cli.ts');
const fakeJoinCli = join(fixtureRoot, 'lark-cli');
const fakeBotmux = join(fixtureRoot, 'botmux');
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
  if (process.env.FAKE_MUTATE_SUPERVISOR === '1') assignment.supervisorTaskId = 'deadbeef';
  if (process.env.FAKE_MUTATE_MONITOR_NAME === '1') assignment.monitoringTaskName = 'feishu-meeting-monitor-wrong';
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
  writeFileSync(fakeBotmux, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.FAKE_BOTMUX_LOG!;
appendFileSync(log, JSON.stringify(args) + '\\n');
const delay = Number(process.env.FAKE_BOTMUX_DELAY_MS ?? '0');
if (delay > 0) await Bun.sleep(delay);
const statePath = process.env.FAKE_BOTMUX_STATE!;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { tasks: {} };
if (args[0] === 'schedule' && args[1] === 'add') {
  const id = args[args.indexOf('--id') + 1];
  if (state.tasks[id]) process.exit(1);
  state.tasks[id] = { name: args[args.indexOf('--name') + 1] };
  writeFileSync(statePath, JSON.stringify(state));
  console.log('created');
  process.exit(0);
}
if (args[0] === 'schedule' && args[1] === 'run') {
  const failOnce = process.env.FAKE_BOTMUX_RUN_FAIL_ONCE_FILE;
  if (failOnce && !existsSync(failOnce)) {
    writeFileSync(failOnce, 'failed');
    console.error('synthetic run interruption');
    process.exit(1);
  }
  if (!state.tasks[args[2]]) process.exit(1);
  console.log('run requested');
  process.exit(0);
}
if (args[0] === 'send') {
  console.log(JSON.stringify({ success: true, messageId: 'om_supervisor_status' }));
  process.exit(0);
}
console.error('unexpected fake botmux command');
process.exit(2);
`, { mode: 0o700 });
  chmodSync(fakeBotmux, 0o700);
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

function writeMeetingAssignment(
  archiveDir: string,
  overrides: Record<string, unknown> = {},
): string {
  mkdirSync(archiveDir, { recursive: true });
  const assignmentId = String(overrides.assignmentId ?? 'assignment-join-1');
  const path = join(archiveDir, 'assignment.json');
  writeFileSync(path, JSON.stringify({
    assignmentId,
    revision: 1,
    meeting: 'https://example.invalid/meeting/123456789',
    assigner: 'ou_assigner123',
    attendeeBotOpenId: 'ou_currentbot123',
    mode: 'proxy',
    allowedRecipients: ['ou_assigner123'],
    deliveryDestination: {
      chatId: 'oc_meetingtest123',
      rootMessageId: 'om_meetingroot123',
      recipientOpenId: 'ou_assigner123',
    },
    executionIsolation: 'new-topic',
    monitoringTaskName: `feishu-meeting-monitor-${assignmentId}`,
    supervisorTaskId: '1234abcd',
    archiveDir,
    statusPath: join(archiveDir, 'status.json'),
    pollIntervalMs: 5_000,
    ...overrides,
  }) + '\n');
  return path;
}

function supervisorEnv(archiveDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const log = join(archiveDir, 'botmux-commands.ndjson');
  const state = join(archiveDir, 'botmux-state.json');
  if (!existsSync(log)) writeFileSync(log, '');
  return {
    ...process.env,
    PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
    FAKE_BOTMUX_LOG: log,
    FAKE_BOTMUX_STATE: state,
    ...extra,
  } as Record<string, string>;
}

async function runSupervisor(
  assignmentFile: string,
  nowMs: number,
  env: Record<string, string>,
  extraArgs: string[] = [],
): Promise<PollerResult> {
  const child = Bun.spawn([
    'bun', supervisor,
    '--assignment-file', assignmentFile,
    '--now-ms', String(nowMs),
    '--lease-ms', '1000',
    ...extraArgs,
  ], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  const status = line ? JSON.parse(line).status : 'missing';
  return { exitCode, status, stdout, stderr };
}

function writeAdmission(archiveDir: string, assignmentId: string, revision: number, nowMs: number): void {
  writeFileSync(join(archiveDir, 'admission.json'), JSON.stringify({
    schemaVersion: 1,
    assignmentId,
    assignmentRevision: revision,
    meetingId: 'meeting-joined-id',
    meetingNo: '123456789',
    botOpenId: 'ou_currentbot123',
    mode: 'proxy',
    greetingOutcome: 'sent',
    serverParticipantVerifiedAt: new Date(nowMs).toISOString(),
  }) + '\n');
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
  test('assignment schema requires trusted bot, supervisor, and deterministic monitor identity', () => {
    const schema = JSON.parse(readFileSync(assignmentSchema, 'utf8'));
    expect(schema.required).toEqual(expect.arrayContaining([
      'attendeeBotOpenId',
      'supervisorTaskId',
      'monitoringTaskName',
    ]));
    expect(schema.properties.monitoringTaskName.pattern).toBe('^feishu-meeting-monitor-[A-Za-z0-9_-]{8,128}$');
  });

  test('re-reads a near-start mode change before sending the greeting', () => {
    const archiveDir = join(fixtureRoot, 'join-archive');
    const assignmentFile = writeMeetingAssignment(archiveDir);
    const commandLog = join(fixtureRoot, 'join-commands.ndjson');
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
    expect(output.admissionWritten).toBe(true);
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
    expect(JSON.parse(readFileSync(join(archiveDir, 'admission.json'), 'utf8'))).toMatchObject({
      assignmentId: 'assignment-join-1',
      assignmentRevision: 2,
      botOpenId: 'ou_currentbot123',
      greetingOutcome: 'silent_not_required',
    });
    const commands = readFileSync(commandLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.some(args => args.includes('+meeting-join'))).toBe(true);
    expect(commands.some(args => args.includes('--with-participants'))).toBe(true);
    expect(commands.some(args => args.includes('+meeting-message-send'))).toBe(false);
  });

  test('persists one deduplicated host-action incident only after the server omits the trusted bot', () => {
    const archiveDir = join(fixtureRoot, 'join-archive-absent');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-join-absent' });
    const commandLog = join(fixtureRoot, 'join-commands-absent.ndjson');
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
    const archiveDir = join(fixtureRoot, 'join-archive-recovered');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-join-recovered' });
    const commandLog = join(fixtureRoot, 'join-commands-recovered.ndjson');
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
    const archiveDir = join(fixtureRoot, 'join-archive-query-failed');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-join-query-failed' });
    const commandLog = join(fixtureRoot, 'join-commands-query-failed.ndjson');
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

  test('refuses admission when the durable supervisor identity changes after join', () => {
    const archiveDir = join(fixtureRoot, 'join-archive-supervisor-changed');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-join-guarded' });
    const commandLog = join(fixtureRoot, 'join-commands-supervisor-changed.ndjson');
    writeFileSync(commandLog, '');
    const result = Bun.spawnSync(['bun', joinHelper, '--assignment-file', assignmentFile], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
        FAKE_ASSIGNMENT_FILE: assignmentFile,
        FAKE_JOIN_LOG: commandLog,
        FAKE_KEEP_ASSIGNMENT_REVISION: '1',
        FAKE_MUTATE_SUPERVISOR: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(3);
    expect(new TextDecoder().decode(result.stderr)).toContain('supervisorTaskId changed or disappeared');
    expect(existsSync(join(archiveDir, 'admission.json'))).toBe(false);
    const commands = readFileSync(commandLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.some(args => args.includes('+meeting-message-send'))).toBe(false);
  });

  test('rejects a non-deterministic monitoring task name before joining', () => {
    const archiveDir = join(fixtureRoot, 'join-archive-bad-monitor-name');
    const assignmentFile = writeMeetingAssignment(archiveDir, {
      assignmentId: 'assignment-join-nameguard',
      monitoringTaskName: 'feishu-meeting-monitor-wrong',
    });
    const commandLog = join(fixtureRoot, 'join-commands-bad-monitor-name.ndjson');
    writeFileSync(commandLog, '');
    const result = Bun.spawnSync(['bun', joinHelper, '--assignment-file', assignmentFile], {
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
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain('non-deterministic monitoringTaskName');
    expect(readFileSync(commandLog, 'utf8')).toBe('');
  });

  test('refuses to join before a durable supervisor task exists', () => {
    const archiveDir = join(fixtureRoot, 'join-archive-no-supervisor');
    const assignmentFile = writeMeetingAssignment(archiveDir, {
      assignmentId: 'assignment-join-nosupervisor',
      supervisorTaskId: '',
    });
    const commandLog = join(fixtureRoot, 'join-commands-no-supervisor.ndjson');
    writeFileSync(commandLog, '');
    const result = Bun.spawnSync(['bun', joinHelper, '--assignment-file', assignmentFile], {
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
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain('invalid supervisorTaskId');
    expect(readFileSync(commandLog, 'utf8')).toBe('');
  });
});

describe('supervisor monitoring recovery', () => {
  test('recovers a missing monitoring dispatch 30 seconds after verified admission', async () => {
    const archiveDir = join(fixtureRoot, 'supervisor-recover-dispatch');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-supervisor-recover' });
    const admittedAt = 2_000_000;
    writeAdmission(archiveDir, 'assignment-supervisor-recover', 1, admittedAt);
    const env = supervisorEnv(archiveDir);
    const result = await runSupervisor(assignmentFile, admittedAt + 30_000, env);
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('monitoring_dispatch_recovered');
    const assignment = JSON.parse(readFileSync(assignmentFile, 'utf8'));
    expect(assignment.scheduleTaskId).toMatch(/^[a-f0-9]{8}$/);
    const dispatch = JSON.parse(readFileSync(join(archiveDir, 'monitoring.dispatch.json'), 'utf8'));
    expect(dispatch).toMatchObject({ phase: 'run_requested', taskId: assignment.scheduleTaskId });
    const commands = readFileSync(env.FAKE_BOTMUX_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'add')).toHaveLength(1);
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'run')).toHaveLength(1);
  });

  test('repairs an interrupted add-before-run sequence on the next tick', async () => {
    const archiveDir = join(fixtureRoot, 'supervisor-interrupted-dispatch');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-supervisor-interrupt' });
    const admittedAt = 3_000_000;
    writeAdmission(archiveDir, 'assignment-supervisor-interrupt', 1, admittedAt);
    const failOnce = join(archiveDir, 'run-failed-once');
    const env = supervisorEnv(archiveDir, { FAKE_BOTMUX_RUN_FAIL_ONCE_FILE: failOnce });
    const first = await runSupervisor(assignmentFile, admittedAt + 30_000, env);
    expect(first.exitCode).not.toBe(0);
    expect(JSON.parse(readFileSync(join(archiveDir, 'monitoring.dispatch.json'), 'utf8')).phase).toBe('created');
    const second = await runSupervisor(assignmentFile, admittedAt + 61_000, env);
    expect(second.exitCode).toBe(0);
    expect(second.status).toBe('monitoring_dispatch_recovered');
    expect(JSON.parse(readFileSync(join(archiveDir, 'monitoring.dispatch.json'), 'utf8')).phase).toBe('run_requested');
    const commands = readFileSync(env.FAKE_BOTMUX_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'add')).toHaveLength(2);
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'run')).toHaveLength(2);
  });

  test('reconciles a task created before assignment persistence', async () => {
    const archiveDir = join(fixtureRoot, 'supervisor-created-before-persist');
    const selectedAssignmentId = 'assignment-supervisor-halfpersist';
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: selectedAssignmentId });
    const admittedAt = 3_500_000;
    writeAdmission(archiveDir, selectedAssignmentId, 1, admittedAt);
    const env = supervisorEnv(archiveDir);
    const taskId = createHash('sha256')
      .update(`feishu-meeting-attendee:monitor:v1:${selectedAssignmentId}`)
      .digest('hex')
      .slice(0, 8);
    writeFileSync(env.FAKE_BOTMUX_STATE, JSON.stringify({
      tasks: { [taskId]: { name: `feishu-meeting-monitor-${selectedAssignmentId}` } },
    }));
    const result = await runSupervisor(assignmentFile, admittedAt + 30_000, env);
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('monitoring_dispatch_recovered');
    expect(JSON.parse(readFileSync(assignmentFile, 'utf8')).scheduleTaskId).toBe(taskId);
    const commands = readFileSync(env.FAKE_BOTMUX_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'add')).toHaveLength(1);
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'run')).toHaveLength(1);
  });

  test('overlapping ticks acquire one lease and create one monitoring task', async () => {
    const archiveDir = join(fixtureRoot, 'supervisor-overlap');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-supervisor-overlap' });
    const admittedAt = 4_000_000;
    writeAdmission(archiveDir, 'assignment-supervisor-overlap', 1, admittedAt);
    const env = supervisorEnv(archiveDir, { FAKE_BOTMUX_DELAY_MS: '150' });
    const results = await Promise.all(Array.from({ length: 4 }, () => (
      runSupervisor(assignmentFile, admittedAt + 30_000, env)
    )));
    expect(results.filter(result => result.status === 'monitoring_dispatch_recovered')).toHaveLength(1);
    expect(results.filter(result => result.status === 'already_running')).toHaveLength(3);
    const commands = readFileSync(env.FAKE_BOTMUX_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'add')).toHaveLength(1);
    expect(commands.filter(args => args[0] === 'schedule' && args[1] === 'run')).toHaveLength(1);
  });

  test('takes over an expired half-written lease without duplicating dispatch', async () => {
    const archiveDir = join(fixtureRoot, 'supervisor-half-written-lease');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-supervisor-halflease' });
    const admittedAt = 5_000_000;
    writeAdmission(archiveDir, 'assignment-supervisor-halflease', 1, admittedAt);
    const leaseDir = join(archiveDir, '.supervisor.tick.lease');
    mkdirSync(leaseDir);
    writeFileSync(join(leaseDir, 'owner.json'), '{"acquiredAtMs":');
    const env = supervisorEnv(archiveDir);
    const result = await runSupervisor(assignmentFile, Date.now() + 2_000, env);
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('monitoring_dispatch_recovered');
    expect(existsSync(leaseDir)).toBe(false);
    expect(readdirSync(archiveDir).some(name => name.startsWith('.supervisor.tick.lease.stale-'))).toBe(false);
  });

  test('sends one monitoring status only after lock and heartbeat proof exist', async () => {
    const archiveDir = join(fixtureRoot, 'supervisor-monitoring-receipt');
    const assignmentFile = writeMeetingAssignment(archiveDir, { assignmentId: 'assignment-supervisor-status' });
    const nowMs = 6_000_000;
    writeAdmission(archiveDir, 'assignment-supervisor-status', 1, nowMs - 60_000);
    writeFileSync(join(archiveDir, '.poll.lock'), JSON.stringify({ pid: process.pid, ownerToken: 'test' }));
    writeFileSync(join(archiveDir, 'status.json'), JSON.stringify({
      schemaVersion: 1,
      assignmentId: 'assignment-supervisor-status',
      phase: 'monitoring',
      updatedAt: new Date(nowMs).toISOString(),
    }));
    const env = supervisorEnv(archiveDir);
    const first = await runSupervisor(assignmentFile, nowMs, env);
    const second = await runSupervisor(assignmentFile, nowMs + 1_000, env);
    expect([first.status, second.status]).toEqual(['monitoring', 'monitoring']);
    const receipt = join(archiveDir, 'monitoring.delivery.receipt.assignment-supervisor-status.ou_assigner123.json');
    expect(JSON.parse(readFileSync(receipt, 'utf8')).messageId).toBe('om_supervisor_status');
    const commands = readFileSync(env.FAKE_BOTMUX_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(commands.filter(args => args[0] === 'send')).toHaveLength(1);
  });
});
