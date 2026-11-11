#!/usr/bin/env bun

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type MeetingMode = 'silent' | 'proxy' | 'assistant';

interface Assignment {
  assignmentId: string;
  revision: number;
  meeting: string;
  assigner: string;
  attendeeBotOpenId: string;
  mode: MeetingMode;
  allowedRecipients: string[];
  deliveryDestination: {
    chatId: string;
    rootMessageId?: string;
    recipientOpenId: string;
  };
  executionIsolation: 'new-topic';
  monitoringTaskName: string;
  supervisorTaskId: string;
  archiveDir: string;
  statusPath: string;
  pollIntervalMs: number;
  scheduledEnd?: string;
}

interface StartLease {
  path: string;
  token: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function usage(exitCode: number): never {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write([
    'Usage: start-active-meeting.ts --meeting NUMBER_OR_LINK --assignment-id ID',
    '  --assigner OPEN_ID --attendee-bot-open-id OPEN_ID --chat-id CHAT_ID',
    '  --archive-dir DIR [--root-message-id MESSAGE_ID]',
    '  [--mode silent|proxy|assistant] [--poll-ms N] [--scheduled-end ISO_TIME]',
    '  [--intro TEXT] [--workdir DIR] [--start-lease-ms N] [--now-ms N] [--dry-run]',
  ].join('\n') + '\n');
  process.exit(exitCode);
}

function optionValue(args: string[], name: string): string | undefined {
  const eq = args.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = optionValue(args, name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerOption(args: string[], name: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = optionValue(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseMode(raw: string | undefined): MeetingMode {
  const value = raw ?? 'proxy';
  if (value !== 'silent' && value !== 'proxy' && value !== 'assistant') {
    throw new Error('--mode must be silent, proxy, or assistant');
  }
  return value;
}

function expandPath(value: string): string {
  return resolve(value.replace(/^~(?=\/|$)/, homedir()));
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function stableTaskId(kind: 'supervisor' | 'monitor', assignmentId: string): string {
  return createHash('sha256')
    .update(`feishu-meeting-attendee:${kind}:v1:${assignmentId}`)
    .digest('hex')
    .slice(0, 8);
}

function meetingNumber(reference: string): string {
  const number = reference.match(/(?:^|\D)(\d{9})(?:\D|$)/)?.[1];
  if (!number) throw new Error('--meeting must be a 9-digit meeting number or a link containing one');
  return number;
}

function buildAssignment(args: string[]): Assignment {
  const assignmentId = requiredOption(args, '--assignment-id');
  const meeting = requiredOption(args, '--meeting');
  const assigner = requiredOption(args, '--assigner');
  const attendeeBotOpenId = requiredOption(args, '--attendee-bot-open-id');
  const chatId = requiredOption(args, '--chat-id');
  const archiveDir = expandPath(requiredOption(args, '--archive-dir'));
  const rootMessageId = optionValue(args, '--root-message-id')?.trim();
  const mode = parseMode(optionValue(args, '--mode'));
  const pollIntervalMs = integerOption(args, '--poll-ms', 5_000, 1_000, 300_000);
  const scheduledEnd = optionValue(args, '--scheduled-end')?.trim();

  meetingNumber(meeting);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(assignmentId)) throw new Error('invalid --assignment-id');
  if (!/^ou_[A-Za-z0-9]+$/.test(assigner)) throw new Error('invalid --assigner');
  if (!/^ou_[A-Za-z0-9]+$/.test(attendeeBotOpenId)) throw new Error('invalid --attendee-bot-open-id');
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error('invalid --chat-id');
  if (rootMessageId && !/^om_[A-Za-z0-9_-]+$/.test(rootMessageId)) throw new Error('invalid --root-message-id');
  if (scheduledEnd && !Number.isFinite(Date.parse(scheduledEnd))) throw new Error('invalid --scheduled-end');

  return {
    assignmentId,
    revision: 1,
    meeting,
    assigner,
    attendeeBotOpenId,
    mode,
    allowedRecipients: [assigner],
    deliveryDestination: {
      chatId,
      ...(rootMessageId ? { rootMessageId } : {}),
      recipientOpenId: assigner,
    },
    executionIsolation: 'new-topic',
    monitoringTaskName: `feishu-meeting-monitor-${assignmentId}`,
    supervisorTaskId: stableTaskId('supervisor', assignmentId),
    archiveDir,
    statusPath: join(archiveDir, 'status.json'),
    pollIntervalMs,
    ...(scheduledEnd ? { scheduledEnd } : {}),
  };
}

function assertSameAssignment(existing: Record<string, unknown>, expected: Assignment): void {
  const keys: Array<keyof Assignment> = [
    'assignmentId',
    'meeting',
    'assigner',
    'attendeeBotOpenId',
    'executionIsolation',
    'monitoringTaskName',
    'supervisorTaskId',
    'archiveDir',
    'statusPath',
    'pollIntervalMs',
  ];
  for (const key of keys) {
    if (existing[key] !== expected[key]) throw new Error(`existing assignment conflicts on ${key}`);
  }
  if (JSON.stringify(existing.deliveryDestination) !== JSON.stringify(expected.deliveryDestination)) {
    throw new Error('existing assignment conflicts on deliveryDestination');
  }
}

function currentAssignment(path: string, expected: Assignment): Assignment {
  const existing = readJson(path);
  assertSameAssignment(existing, expected);
  const revision = Number(existing.revision);
  const mode = existing.mode;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('existing assignment has an invalid revision');
  if (mode !== 'silent' && mode !== 'proxy' && mode !== 'assistant') {
    throw new Error('existing assignment has an invalid mode');
  }
  return { ...expected, revision, mode };
}

function persistAssignment(assignment: Assignment): string {
  mkdirSync(assignment.archiveDir, { recursive: true, mode: 0o700 });
  chmodSync(assignment.archiveDir, 0o700);
  const path = join(assignment.archiveDir, 'assignment.json');
  if (existsSync(path)) assertSameAssignment(readJson(path), assignment);
  else atomicWriteJson(path, assignment);
  return path;
}

function persistStartContract(assignment: Assignment): string {
  const path = join(assignment.archiveDir, 'active-start.contract.json');
  const contract = {
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    meeting: assignment.meeting,
    assigner: assignment.assigner,
    attendeeBotOpenId: assignment.attendeeBotOpenId,
    deliveryDestination: assignment.deliveryDestination,
    supervisorTaskId: assignment.supervisorTaskId,
    monitoringTaskName: assignment.monitoringTaskName,
  };
  if (existsSync(path)) {
    if (JSON.stringify(readJson(path)) !== JSON.stringify(contract)) {
      throw new Error('active-start contract conflicts with the requested immutable identity or destination');
    }
  } else {
    atomicWriteJson(path, contract);
  }
  return path;
}

function leaseTimestamp(path: string): number {
  try {
    const owner = readJson(join(path, 'owner.json'));
    const value = Number(owner.acquiredAtMs);
    if (Number.isFinite(value) && value >= 0) return value;
  } catch {}
  return statSync(path).mtimeMs;
}

function leaseOwnerIsLive(path: string): boolean {
  try {
    const owner = readJson(join(path, 'owner.json'));
    const pid = Number(owner.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireStartLease(archiveDir: string, nowMs: number, leaseMs: number): StartLease | undefined {
  const path = join(archiveDir, '.active-start.lease');
  const takeover = join(archiveDir, '.active-start.takeover');
  const token = randomBytes(16).toString('hex');
  const writeOwner = () => atomicWriteJson(join(path, 'owner.json'), { pid: process.pid, token, acquiredAtMs: nowMs });
  try {
    mkdirSync(path, { mode: 0o700 });
    writeOwner();
    return { path, token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (leaseOwnerIsLive(path) || nowMs - leaseTimestamp(path) < leaseMs) return undefined;
  try {
    mkdirSync(takeover, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    if (!existsSync(path) || leaseOwnerIsLive(path) || nowMs - leaseTimestamp(path) < leaseMs) return undefined;
    const stale = `${path}.stale-${nowMs}-${token.slice(0, 8)}`;
    renameSync(path, stale);
    try {
      mkdirSync(path, { mode: 0o700 });
      writeOwner();
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
    return { path, token };
  } finally {
    rmSync(takeover, { recursive: true, force: true });
  }
}

function releaseStartLease(lease: StartLease): void {
  try {
    const owner = readJson(join(lease.path, 'owner.json'));
    if (owner.token === lease.token) rmSync(lease.path, { recursive: true, force: true });
  } catch {}
}

function run(command: string, args: string[], timeoutMs = 30_000): CommandResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.error?.message ?? result.stderr ?? '',
    exitCode: result.status,
  };
}

function supervisorPrompt(assignmentFile: string): string {
  return [
    'Use the feishu-meeting-attendee skill as the independent technical supervisor for one assignment.',
    `Read the trusted assignment from ${assignmentFile}.`,
    `Run: bun "${join(dirname(import.meta.path), 'supervisor-tick.ts')}" --assignment-file "${assignmentFile}"`,
    'Deliver durable pending technical notifications and a finalized report only to the persisted destination.',
    'After a confirmed final delivery receipt or confirmed action_required delivery, run botmux schedule done self --note "meeting attendance delivery settled". Otherwise leave the task active and remain silent.',
  ].join('\n');
}

function ensureSupervisor(assignment: Assignment, assignmentFile: string, workdir: string, nowMs: number): void {
  const ledgerPath = join(assignment.archiveDir, 'supervisor.dispatch.json');
  if (existsSync(ledgerPath)) {
    const ledger = readJson(ledgerPath);
    if (ledger.taskId !== assignment.supervisorTaskId || ledger.phase !== 'created') {
      throw new Error('supervisor dispatch is ambiguous and requires reconciliation');
    }
    return;
  }
  atomicWriteJson(ledgerPath, {
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    taskId: assignment.supervisorTaskId,
    phase: 'create_requested',
    requestedAt: new Date(nowMs).toISOString(),
  });
  const deadline = assignment.scheduledEnd
    ? new Date(Date.parse(assignment.scheduledEnd) + 2 * 60 * 60 * 1_000).toISOString()
    : new Date(nowMs + 8 * 60 * 60 * 1_000).toISOString();
  const result = run('botmux', [
    'schedule', 'add', 'every 1m', supervisorPrompt(assignmentFile),
    '--id', assignment.supervisorTaskId,
    '--name', `feishu-meeting-supervisor-${assignment.assignmentId}`,
    '--chat-id', assignment.deliveryDestination.chatId,
    '--new-topic',
    '--silent',
    '--workdir', workdir,
    '--until-done',
    '--deadline', deadline,
    '--retry-every', '1m',
    '--notify', 'failing,expired',
  ]);
  if (!result.ok) {
    throw new Error(`supervisor task creation was not confirmed: ${(result.stderr || result.stdout).slice(0, 500)}`);
  }
  atomicWriteJson(ledgerPath, {
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    taskId: assignment.supervisorTaskId,
    taskName: `feishu-meeting-supervisor-${assignment.assignmentId}`,
    phase: 'created',
    createdAt: new Date(nowMs).toISOString(),
  });
}

function validAdmission(assignment: Assignment): boolean {
  const path = join(assignment.archiveDir, 'admission.json');
  if (!existsSync(path)) return false;
  try {
    const admission = readJson(path);
    return admission.assignmentId === assignment.assignmentId
      && admission.assignmentRevision === assignment.revision
      && admission.meetingNo === meetingNumber(assignment.meeting)
      && admission.botOpenId === assignment.attendeeBotOpenId
      && typeof admission.meetingId === 'string'
      && new Set(['silent_not_required', 'sent', 'uncertain_do_not_retry']).has(String(admission.greetingOutcome));
  } catch {
    return false;
  }
}

function parseCommandJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const value: unknown = JSON.parse(raw.trim());
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function runJoinHelper(assignmentFile: string, intro: string | undefined): Record<string, unknown> {
  const helper = join(dirname(import.meta.path), 'join-and-greet.ts');
  const args = [helper, '--assignment-file', assignmentFile];
  if (intro) args.push('--intro', intro);
  const result = run(process.execPath, args, 90_000);
  const output = parseCommandJson(result.ok ? result.stdout : (result.stderr || result.stdout));
  if (output.attendanceVerified !== true || output.admissionWritten !== true) {
    throw new Error(`meeting admission failed: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  }
  if (result.ok && output.ok !== true) {
    throw new Error('meeting admission proof did not validate');
  }
  return output;
}

function dispatchMonitoring(assignmentFile: string, nowMs: number): Record<string, unknown> {
  const helper = join(dirname(import.meta.path), 'supervisor-tick.ts');
  const result = run(process.execPath, [
    helper,
    '--assignment-file', assignmentFile,
    '--recovery-after-ms', '0',
    '--now-ms', String(nowMs),
  ]);
  if (!result.ok) throw new Error(`monitoring dispatch failed but remains supervisor-recoverable: ${(result.stderr || result.stdout).slice(0, 1000)}`);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  const output = line ? JSON.parse(line) as Record<string, unknown> : {};
  if (output.status !== 'monitoring_dispatch_recovered'
    && output.status !== 'monitoring_dispatch_pending'
    && output.status !== 'monitoring') {
    throw new Error(`unexpected monitoring dispatch status: ${String(output.status)}`);
  }
  return output;
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);
const assignment = buildAssignment(argv);
const nowMs = integerOption(argv, '--now-ms', Date.now(), 0);
const workdir = expandPath(optionValue(argv, '--workdir') ?? process.cwd());
const startLeaseMs = integerOption(argv, '--start-lease-ms', 120_000, 1_000);
const intro = optionValue(argv, '--intro');

if (argv.includes('--dry-run')) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, assignment, assignmentFile: join(assignment.archiveDir, 'assignment.json') })}\n`);
  process.exit(0);
}

const startedAt = Date.now();
const assignmentFile = persistAssignment(assignment);
persistStartContract(assignment);
const lease = acquireStartLease(assignment.archiveDir, nowMs, startLeaseMs);
if (!lease) {
  process.stdout.write(`${JSON.stringify({ ok: true, status: 'already_starting', assignmentId: assignment.assignmentId })}\n`);
  process.exit(0);
}

try {
  ensureSupervisor(assignment, assignmentFile, workdir, nowMs);
  let appliedAssignment = currentAssignment(assignmentFile, assignment);
  let admission: Record<string, unknown> = { reused: true };
  if (!validAdmission(appliedAssignment)) admission = runJoinHelper(assignmentFile, intro);
  appliedAssignment = currentAssignment(assignmentFile, assignment);
  if (!validAdmission(appliedAssignment)) throw new Error('meeting admission proof did not validate');
  const monitoring = dispatchMonitoring(assignmentFile, Math.max(nowMs, Date.now()));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'admitted_monitoring_dispatched',
    assignmentId: assignment.assignmentId,
    assignmentFile,
    supervisorTaskId: assignment.supervisorTaskId,
    admission,
    admissionUpdate: {
      text: '已入会，正在启动监控。',
      assignmentRevision: appliedAssignment.revision,
      deliveryDestination: appliedAssignment.deliveryDestination,
    },
    monitoring,
    elapsedMs: Date.now() - startedAt,
  })}\n`);
} finally {
  releaseStartLease(lease);
}
