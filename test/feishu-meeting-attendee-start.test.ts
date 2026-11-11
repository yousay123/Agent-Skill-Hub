import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const starter = join(root, 'skills', 'feishu-meeting-attendee', 'scripts', 'start-active-meeting.ts');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'meeting-fast-start-test-'));
const fakeBotmux = join(fixtureRoot, 'botmux');
const fakeLark = join(fixtureRoot, 'lark-cli');

interface StartResult {
  exitCode: number;
  status: string;
  stdout: string;
  stderr: string;
}

beforeAll(() => {
  writeFileSync(fakeBotmux, `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.FAKE_EVENT_LOG!;
appendFileSync(log, JSON.stringify({ kind: 'botmux', args }) + '\\n');
if (args[0] === 'schedule' && args[1] === 'add') {
  const name = args[args.indexOf('--name') + 1];
  const delay = name.startsWith('feishu-meeting-supervisor-')
    ? Number(process.env.FAKE_SUPERVISOR_DELAY_MS ?? process.env.FAKE_BOTMUX_DELAY_MS ?? '0')
    : Number(process.env.FAKE_BOTMUX_DELAY_MS ?? '0');
  if (delay) await Bun.sleep(delay);
  if (process.env.FAKE_FAIL_SUPERVISOR_ADD === '1' && name.startsWith('feishu-meeting-supervisor-')) {
    console.error('synthetic supervisor add failure');
    process.exit(1);
  }
  const statePath = process.env.FAKE_BOTMUX_STATE!;
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { tasks: {} };
  const id = args[args.indexOf('--id') + 1];
  if (state.tasks[id]) process.exit(1);
  state.tasks[id] = { name };
  writeFileSync(statePath, JSON.stringify(state));
  console.log('created');
  process.exit(0);
}
if (args[0] === 'schedule' && args[1] === 'run') {
  const failure = process.env.FAKE_MONITOR_RUN_FAIL_ONCE_FILE;
  if (failure && !existsSync(failure)) {
    writeFileSync(failure, 'failed');
    console.error('synthetic monitor run failure');
    process.exit(1);
  }
  console.log('run requested');
  process.exit(0);
}
if (args[0] === 'send') {
  console.log(JSON.stringify({ success: true, messageId: 'om_fast_admission' }));
  process.exit(0);
}
console.error('unexpected botmux command');
process.exit(2);
`, { mode: 0o700 });
  chmodSync(fakeBotmux, 0o700);

  writeFileSync(fakeLark, `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_EVENT_LOG!, JSON.stringify({ kind: 'lark', args }) + '\\n');
if (args.includes('+meeting-join')) {
  if (process.env.FAKE_MUTATE_MODE_ON_JOIN === '1') {
    const assignment = JSON.parse(readFileSync(process.env.FAKE_ASSIGNMENT_FILE!, 'utf8'));
    assignment.revision += 1;
    assignment.mode = 'silent';
    writeFileSync(process.env.FAKE_ASSIGNMENT_FILE!, JSON.stringify(assignment) + '\\n');
  }
  console.log(JSON.stringify({ ok: true, data: { meeting: { id: 'meeting-fast-id' } } }));
  process.exit(0);
}
if (args.includes('meeting') && args.includes('get')) {
  const assignment = JSON.parse(readFileSync(process.env.FAKE_ASSIGNMENT_FILE!, 'utf8'));
  if (process.env.FAKE_MUTATE_DESTINATION_ON_VERIFY === '1') {
    assignment.deliveryDestination.chatId = 'oc_retargeted456';
    writeFileSync(process.env.FAKE_ASSIGNMENT_FILE!, JSON.stringify(assignment) + '\\n');
  }
  console.log(JSON.stringify({
    ok: true,
    data: {
      meeting: {
        id: 'meeting-fast-id',
        meeting_no: '123456789',
        participants: [{
          id: assignment.attendeeBotOpenId,
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
  if (process.env.FAKE_GREETING_FAIL === '1') {
    console.error('synthetic uncertain greeting');
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
console.error('unexpected lark command');
process.exit(2);
`, { mode: 0o700 });
  chmodSync(fakeLark, 0o700);
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function starterArgs(archiveDir: string, extraArgs: string[] = []): string[] {
  return [
    'bun', starter,
    '--meeting', 'https://example.invalid/meeting/123456789',
    '--assignment-id', 'assignment-fast-start',
    '--assigner', 'ou_assigner123',
    '--attendee-bot-open-id', 'ou_currentbot123',
    '--chat-id', 'oc_meetingtest123',
    '--root-message-id', 'om_meetingroot123',
    '--archive-dir', archiveDir,
    '--workdir', root,
    '--now-ms', '7000000',
    ...extraArgs,
  ];
}

function starterEnv(archiveDir: string, extra: Record<string, string> = {}): Record<string, string> {
  const log = join(archiveDir, 'events.ndjson');
  const state = join(archiveDir, 'botmux-state.json');
  mkdirSync(archiveDir, { recursive: true });
  if (!existsSync(log)) writeFileSync(log, '');
  return {
    ...process.env,
    PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
    FAKE_EVENT_LOG: log,
    FAKE_BOTMUX_STATE: state,
    FAKE_ASSIGNMENT_FILE: join(archiveDir, 'assignment.json'),
    ...extra,
  } as Record<string, string>;
}

async function runStarter(archiveDir: string, env: Record<string, string>, extraArgs: string[] = []): Promise<StartResult> {
  const child = Bun.spawn(starterArgs(archiveDir, extraArgs), { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  const status = line ? JSON.parse(line).status : 'missing';
  return { exitCode, status, stdout, stderr };
}

function events(archiveDir: string): Array<{ kind: string; args: string[] }> {
  return readFileSync(join(archiveDir, 'events.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('active-meeting fast start', () => {
  test('creates the independent supervisor before joining and dispatches monitoring in one bounded command', async () => {
    const archiveDir = join(fixtureRoot, 'happy');
    const env = starterEnv(archiveDir);
    const result = await runStarter(archiveDir, env);

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('admitted_monitoring_dispatched');
    expect(existsSync(join(archiveDir, 'admission.json'))).toBe(true);
    expect(JSON.parse(result.stdout).admissionUpdate).toMatchObject({
      text: '已入会，正在启动监控。',
      assignmentRevision: 1,
      deliveryDestination: { chatId: 'oc_meetingtest123', rootMessageId: 'om_meetingroot123' },
    });
    expect(JSON.parse(readFileSync(join(archiveDir, 'monitoring.dispatch.json'), 'utf8')).phase).toBe('run_requested');

    const recorded = events(archiveDir);
    const supervisorAdd = recorded.findIndex(event => event.args.includes('feishu-meeting-supervisor-assignment-fast-start'));
    const joinMeeting = recorded.findIndex(event => event.kind === 'lark' && event.args.includes('+meeting-join'));
    const monitorAdd = recorded.findIndex(event => event.args.includes('feishu-meeting-monitor-assignment-fast-start'));
    const monitorRun = recorded.findIndex(event => event.kind === 'botmux' && event.args[0] === 'schedule' && event.args[1] === 'run');
    expect(supervisorAdd).toBeGreaterThanOrEqual(0);
    expect(supervisorAdd).toBeLessThan(joinMeeting);
    expect(joinMeeting).toBeLessThan(monitorAdd);
    expect(monitorAdd).toBeLessThan(monitorRun);
    expect(recorded.some(event => event.kind === 'botmux' && event.args[0] === 'send')).toBe(false);
  });

  test('fails closed before joining when the durable supervisor cannot be created', async () => {
    const archiveDir = join(fixtureRoot, 'supervisor-failure');
    const env = starterEnv(archiveDir, { FAKE_FAIL_SUPERVISOR_ADD: '1' });
    const result = await runStarter(archiveDir, env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('supervisor task creation was not confirmed');
    expect(events(archiveDir).some(event => event.kind === 'lark')).toBe(false);
    expect(JSON.parse(readFileSync(join(archiveDir, 'supervisor.dispatch.json'), 'utf8')).phase).toBe('create_requested');
  });

  test('resumes after add-before-run interruption without rejoining', async () => {
    const archiveDir = join(fixtureRoot, 'resume-monitor');
    const failOnce = join(archiveDir, 'run-failed-once');
    const env = starterEnv(archiveDir, { FAKE_MONITOR_RUN_FAIL_ONCE_FILE: failOnce });

    const first = await runStarter(archiveDir, env);
    expect(first.exitCode).not.toBe(0);
    expect(first.stderr).toContain('remains supervisor-recoverable');
    expect(JSON.parse(readFileSync(join(archiveDir, 'monitoring.dispatch.json'), 'utf8')).phase).toBe('created');

    const second = await runStarter(archiveDir, env);
    expect(second.exitCode).toBe(0);
    expect(second.status).toBe('admitted_monitoring_dispatched');
    const recorded = events(archiveDir);
    expect(recorded.filter(event => event.kind === 'lark' && event.args.includes('+meeting-join'))).toHaveLength(1);
    expect(recorded.filter(event => event.kind === 'botmux' && event.args[0] === 'send')).toHaveLength(0);
    expect(recorded.filter(event => event.kind === 'botmux' && event.args[0] === 'schedule' && event.args[1] === 'run')).toHaveLength(2);
  });

  test('honors a trusted mode revision made while the supervisor is being established', async () => {
    const archiveDir = join(fixtureRoot, 'mode-change');
    const env = starterEnv(archiveDir, { FAKE_MUTATE_MODE_ON_JOIN: '1' });
    const result = await runStarter(archiveDir, env);

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('admitted_monitoring_dispatched');
    expect(JSON.parse(readFileSync(join(archiveDir, 'assignment.json'), 'utf8'))).toMatchObject({ revision: 2, mode: 'silent' });
    expect(JSON.parse(readFileSync(join(archiveDir, 'admission.json'), 'utf8'))).toMatchObject({
      assignmentRevision: 2,
      mode: 'silent',
      greetingOutcome: 'silent_not_required',
    });
    expect(events(archiveDir).some(event => event.kind === 'lark' && event.args.includes('+meeting-message-send'))).toBe(false);
  });

  test('continues monitoring after a terminal uncertain greeting outcome without retrying the greeting', async () => {
    const archiveDir = join(fixtureRoot, 'uncertain-greeting');
    const env = starterEnv(archiveDir, { FAKE_GREETING_FAIL: '1' });
    const result = await runStarter(archiveDir, env);

    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('admitted_monitoring_dispatched');
    expect(JSON.parse(readFileSync(join(archiveDir, 'admission.json'), 'utf8')).greetingOutcome).toBe('uncertain_do_not_retry');
    expect(events(archiveDir).filter(event => event.kind === 'lark' && event.args.includes('+meeting-message-send'))).toHaveLength(1);
  });

  test('refuses an in-place destination revision before any admission update is sent', async () => {
    const archiveDir = join(fixtureRoot, 'destination-change');
    const env = starterEnv(archiveDir, { FAKE_MUTATE_DESTINATION_ON_VERIFY: '1' });
    const result = await runStarter(archiveDir, env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('existing assignment conflicts on deliveryDestination');
    expect(events(archiveDir).filter(event => event.kind === 'botmux' && event.args[0] === 'send')).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(archiveDir, 'active-start.contract.json'), 'utf8')).deliveryDestination.chatId)
      .toBe('oc_meetingtest123');
  });

  test('overlapping starts admit once while the competing invocation exits benignly', async () => {
    const archiveDir = join(fixtureRoot, 'overlap');
    const env = starterEnv(archiveDir, { FAKE_BOTMUX_DELAY_MS: '100' });
    const [first, second] = await Promise.all([runStarter(archiveDir, env), runStarter(archiveDir, env)]);

    expect([first.status, second.status].sort()).toEqual(['admitted_monitoring_dispatched', 'already_starting']);
    const recorded = events(archiveDir);
    expect(recorded.filter(event => event.kind === 'lark' && event.args.includes('+meeting-join'))).toHaveLength(1);
    expect(recorded.filter(event => event.kind === 'botmux' && event.args[0] === 'send')).toHaveLength(0);
  });

  test('does not steal an expired lease from a still-running long supervisor creation', async () => {
    const archiveDir = join(fixtureRoot, 'long-operation-overlap');
    const env = starterEnv(archiveDir, { FAKE_SUPERVISOR_DELAY_MS: '1400' });
    const firstPromise = runStarter(archiveDir, env, ['--start-lease-ms', '1000']);
    await Bun.sleep(1100);
    const second = await runStarter(archiveDir, env, ['--start-lease-ms', '1000']);
    const first = await firstPromise;

    expect(first.status).toBe('admitted_monitoring_dispatched');
    expect(second.status).toBe('already_starting');
    expect(events(archiveDir).filter(event => event.kind === 'lark' && event.args.includes('+meeting-join'))).toHaveLength(1);
  }, 10_000);
});
