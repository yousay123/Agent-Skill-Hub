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
import { basename, dirname, join, resolve } from 'node:path';

interface Assignment {
  assignmentId: string;
  revision: number;
  meeting: string;
  assigner: string;
  attendeeBotOpenId: string;
  allowedRecipients: string[];
  deliveryDestination: {
    chatId: string;
    rootMessageId?: string;
    recipientOpenId: string;
  };
  executionIsolation: 'new-topic';
  archiveDir: string;
  statusPath: string;
  pollIntervalMs: number;
  supervisorTaskId: string;
  monitoringTaskName: string;
  scheduleTaskId?: string;
  scheduledStart?: string;
  [key: string]: unknown;
}

interface Lease {
  token: string;
  path: string;
}

function optionValue(args: string[], name: string): string | undefined {
  const eq = args.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function integerOption(args: string[], name: string, fallback: number, minimum: number): number {
  const raw = optionValue(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a JSON object`);
  return value as Record<string, unknown>;
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function parseAssignment(path: string): Assignment {
  const body = readJson(path);
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : '';
  const revision = Number(body.revision);
  const meeting = typeof body.meeting === 'string' ? body.meeting.trim() : '';
  const assigner = typeof body.assigner === 'string' ? body.assigner.trim() : '';
  const attendeeBotOpenId = typeof body.attendeeBotOpenId === 'string' ? body.attendeeBotOpenId.trim() : '';
  const allowedRecipients = Array.isArray(body.allowedRecipients)
    ? body.allowedRecipients.filter((value): value is string => typeof value === 'string')
    : [];
  const destination = body.deliveryDestination && typeof body.deliveryDestination === 'object' && !Array.isArray(body.deliveryDestination)
    ? body.deliveryDestination as Record<string, unknown>
    : {};
  const chatId = typeof destination.chatId === 'string' ? destination.chatId.trim() : '';
  const rootMessageId = typeof destination.rootMessageId === 'string' ? destination.rootMessageId.trim() : undefined;
  const recipientOpenId = typeof destination.recipientOpenId === 'string' ? destination.recipientOpenId.trim() : '';
  const archiveDir = typeof body.archiveDir === 'string'
    ? resolve(body.archiveDir.replace(/^~(?=\/|$)/, homedir()))
    : '';
  const statusPath = typeof body.statusPath === 'string'
    ? resolve(body.statusPath.replace(/^~(?=\/|$)/, homedir()))
    : '';
  const supervisorTaskId = typeof body.supervisorTaskId === 'string' ? body.supervisorTaskId.trim() : '';
  const monitoringTaskName = typeof body.monitoringTaskName === 'string' ? body.monitoringTaskName.trim() : '';
  const scheduleTaskId = typeof body.scheduleTaskId === 'string' ? body.scheduleTaskId.trim() : undefined;
  const pollIntervalMs = Number(body.pollIntervalMs ?? 5_000);

  if (!/^[A-Za-z0-9_-]{8,128}$/.test(assignmentId)) throw new Error('invalid assignmentId');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid assignment revision');
  if (!meeting) throw new Error('missing meeting reference');
  if (!/^ou_[A-Za-z0-9]+$/.test(assigner)) throw new Error('invalid assigner');
  if (!/^ou_[A-Za-z0-9]+$/.test(attendeeBotOpenId)) throw new Error('invalid attendeeBotOpenId');
  if (!allowedRecipients.includes(assigner) || !allowedRecipients.includes(recipientOpenId)) {
    throw new Error('delivery recipient is not allowed');
  }
  if (!/^ou_[A-Za-z0-9]+$/.test(recipientOpenId) || !/^oc_[A-Za-z0-9]+$/.test(chatId)) {
    throw new Error('invalid delivery destination');
  }
  if (rootMessageId && !/^om_[A-Za-z0-9_-]+$/.test(rootMessageId)) throw new Error('invalid delivery rootMessageId');
  if (body.executionIsolation !== 'new-topic') throw new Error('executionIsolation must be new-topic');
  if (!archiveDir || archiveDir !== dirname(resolve(path))) throw new Error('archiveDir must contain assignment.json');
  if (!statusPath || dirname(statusPath) !== archiveDir || basename(statusPath) !== 'status.json') {
    throw new Error('statusPath must be archiveDir/status.json');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 300_000) {
    throw new Error('invalid pollIntervalMs');
  }
  if (!/^[a-f0-9]{8}$/.test(supervisorTaskId)) throw new Error('invalid supervisorTaskId');
  if (monitoringTaskName !== `feishu-meeting-monitor-${assignmentId}`) {
    throw new Error('monitoringTaskName is not deterministic');
  }
  if (scheduleTaskId && !/^[a-f0-9]{8}$/.test(scheduleTaskId)) throw new Error('invalid scheduleTaskId');

  return {
    ...body,
    assignmentId,
    revision,
    meeting,
    assigner,
    attendeeBotOpenId,
    allowedRecipients,
    deliveryDestination: {
      chatId,
      ...(rootMessageId ? { rootMessageId } : {}),
      recipientOpenId,
    },
    executionIsolation: 'new-topic',
    archiveDir,
    statusPath,
    pollIntervalMs,
    supervisorTaskId,
    monitoringTaskName,
    ...(scheduleTaskId ? { scheduleTaskId } : {}),
    ...(typeof body.scheduledStart === 'string' ? { scheduledStart: body.scheduledStart } : {}),
  };
}

function leaseTimestamp(path: string): number {
  try {
    const owner = readJson(join(path, 'owner.json'));
    const value = Number(owner.acquiredAtMs);
    if (Number.isFinite(value) && value >= 0) return value;
  } catch {}
  return statSync(path).mtimeMs;
}

function acquireLease(archiveDir: string, nowMs: number, leaseMs: number): Lease | undefined {
  const path = join(archiveDir, '.supervisor.tick.lease');
  const takeover = join(archiveDir, '.supervisor.tick.takeover');
  const token = randomBytes(16).toString('hex');
  const writeOwner = () => atomicWriteJson(join(path, 'owner.json'), { pid: process.pid, token, acquiredAtMs: nowMs });
  try {
    mkdirSync(path, { mode: 0o700 });
    writeOwner();
    return { token, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (nowMs - leaseTimestamp(path) < leaseMs) return undefined;

  try {
    mkdirSync(takeover, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    if (!existsSync(path)) return undefined;
    if (nowMs - leaseTimestamp(path) < leaseMs) return undefined;
    const stale = `${path}.stale-${nowMs}-${token.slice(0, 8)}`;
    renameSync(path, stale);
    try {
      mkdirSync(path, { mode: 0o700 });
      writeOwner();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    } finally {
      rmSync(stale, { recursive: true, force: true });
    }
    return { token, path };
  } finally {
    rmSync(takeover, { recursive: true, force: true });
  }
}

function releaseLease(lease: Lease): void {
  try {
    const owner = readJson(join(lease.path, 'owner.json'));
    if (owner.token === lease.token) rmSync(lease.path, { recursive: true, force: true });
  } catch {}
}

function runBotmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('botmux', args, {
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.error?.message ?? result.stderr ?? '',
  };
}

function persistScheduleTaskId(path: string, expected: Assignment, taskId: string): Assignment {
  const latest = parseAssignment(path);
  if (latest.assignmentId !== expected.assignmentId
    || latest.revision !== expected.revision
    || latest.supervisorTaskId !== expected.supervisorTaskId
    || latest.monitoringTaskName !== expected.monitoringTaskName) {
    throw new Error('assignment changed while recovering monitoring dispatch');
  }
  if (latest.scheduleTaskId && latest.scheduleTaskId !== taskId) {
    throw new Error('assignment already references a different monitoring task');
  }
  const persisted = { ...latest, scheduleTaskId: taskId };
  atomicWriteJson(path, persisted);
  return persisted;
}

function validAdmission(assignment: Assignment): Record<string, unknown> | undefined {
  const path = join(assignment.archiveDir, 'admission.json');
  if (!existsSync(path)) return undefined;
  const admission = readJson(path);
  const terminal = new Set(['silent_not_required', 'sent', 'uncertain_do_not_retry']);
  if (admission.assignmentId !== assignment.assignmentId
    || admission.assignmentRevision !== assignment.revision
    || admission.botOpenId !== assignment.attendeeBotOpenId
    || !terminal.has(String(admission.greetingOutcome))) return undefined;
  const meetingNo = assignment.meeting.match(/(?:^|\D)(\d{9})(?:\D|$)/)?.[1];
  if (!meetingNo || admission.meetingNo !== meetingNo || typeof admission.meetingId !== 'string') return undefined;
  return admission;
}

function monitoringHealthy(assignment: Assignment, nowMs: number, staleMs: number): boolean {
  if (!existsSync(join(assignment.archiveDir, '.poll.lock')) || !existsSync(assignment.statusPath)) return false;
  try {
    const status = readJson(assignment.statusPath);
    const updatedAt = Date.parse(String(status.updatedAt ?? ''));
    return status.assignmentId === assignment.assignmentId
      && status.phase === 'monitoring'
      && Number.isFinite(updatedAt)
      && nowMs - updatedAt <= staleMs;
  } catch {
    return false;
  }
}

function confirmedMessageId(stdout: string): string | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const body = value as Record<string, unknown>;
        if (body.success === true && typeof body.messageId === 'string' && /^om_/.test(body.messageId)) return body.messageId;
      }
    } catch {}
  }
  return undefined;
}

function sendMonitoringUpdate(assignment: Assignment, nowMs: number): { sent: boolean; receiptPath: string } {
  const recipient = assignment.deliveryDestination.recipientOpenId;
  const receiptPath = join(assignment.archiveDir, `monitoring.delivery.receipt.${assignment.assignmentId}.${recipient}.json`);
  if (existsSync(receiptPath)) return { sent: false, receiptPath };
  const destination = assignment.deliveryDestination;
  const args = ['send'];
  if (destination.rootMessageId) args.push('--into', destination.rootMessageId, '--chat-id', destination.chatId);
  else args.push('--top-level', '--chat-id', destination.chatId);
  args.push('--mention', recipient, `已入会并监控中。任务：${assignment.assignmentId}`);
  const result = runBotmux(args);
  const messageId = result.ok ? confirmedMessageId(result.stdout) : undefined;
  if (!messageId) throw new Error('monitoring update delivery was not confirmed');
  atomicWriteJson(receiptPath, {
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    recipientOpenId: recipient,
    messageId,
    deliveredAt: new Date(nowMs).toISOString(),
  });
  return { sent: true, receiptPath };
}

function monitoringPrompt(assignment: Assignment, assignmentFile: string): string {
  return [
    'Use the feishu-meeting-attendee skill in an isolated monitoring turn.',
    `Read and validate the assignment from ${assignmentFile}.`,
    'Use a matching admission.json without joining or greeting again; otherwise run the normal verified join path.',
    'Start poll-and-archive with the assignment ID, archive directory, and status path. Keep the turn alive until a terminal provider state or actionable failure.',
    'Deliver only to the persisted delivery destination and preserve pending notifications until delivery is confirmed.',
    `Trusted assignment snapshot: ${JSON.stringify(assignment)}`,
  ].join('\n');
}

function recoverMonitoring(
  assignmentFile: string,
  assignment: Assignment,
  nowMs: number,
  retryAfterMs: number,
): { taskId: string; runRequested: boolean; dispatchPath: string } {
  const dispatchPath = join(assignment.archiveDir, 'monitoring.dispatch.json');
  if (existsSync(dispatchPath)) {
    try {
      const existing = readJson(dispatchPath);
      const lastRun = Date.parse(String(existing.lastRunRequestedAt ?? ''));
      if (existing.taskId === assignment.scheduleTaskId
        && Number.isFinite(lastRun)
        && nowMs - lastRun < retryAfterMs) {
        return { taskId: String(existing.taskId), runRequested: false, dispatchPath };
      }
    } catch {}
  }

  const derivedId = createHash('sha256')
    .update(`feishu-meeting-attendee:monitor:v1:${assignment.assignmentId}`)
    .digest('hex')
    .slice(0, 8);
  const taskId = assignment.scheduleTaskId ?? derivedId;
  const add = runBotmux([
    'schedule', 'add', '1m', monitoringPrompt(assignment, assignmentFile),
    '--id', taskId,
    '--name', assignment.monitoringTaskName,
    '--chat-id', assignment.deliveryDestination.chatId,
    '--new-topic',
    '--silent',
    '--workdir', process.cwd(),
  ]);
  let persisted = assignment;
  if (add.ok) {
    persisted = persistScheduleTaskId(assignmentFile, assignment, taskId);
  }
  atomicWriteJson(dispatchPath, {
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    taskId,
    taskName: assignment.monitoringTaskName,
    phase: 'created',
    addConfirmed: add.ok,
    updatedAt: new Date(nowMs).toISOString(),
  });
  const run = runBotmux(['schedule', 'run', taskId]);
  if (!run.ok) {
    throw new Error(`monitoring task could not be run: ${(run.stderr || run.stdout || add.stderr || add.stdout).slice(0, 500)}`);
  }
  if (persisted.scheduleTaskId !== taskId) {
    persisted = persistScheduleTaskId(assignmentFile, assignment, taskId);
  }
  atomicWriteJson(dispatchPath, {
    schemaVersion: 1,
    assignmentId: persisted.assignmentId,
    taskId,
    taskName: persisted.monitoringTaskName,
    phase: 'run_requested',
    addConfirmed: add.ok,
    lastRunRequestedAt: new Date(nowMs).toISOString(),
  });
  return { taskId, runRequested: true, dispatchPath };
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('Usage: supervisor-tick.ts --assignment-file FILE [--lease-ms N] [--recovery-after-ms N] [--retry-after-ms N] [--heartbeat-stale-ms N] [--now-ms N]\n');
  process.exit(0);
}
const assignmentArg = optionValue(argv, '--assignment-file');
if (!assignmentArg) throw new Error('--assignment-file is required');
const assignmentFile = resolve(assignmentArg.replace(/^~(?=\/|$)/, homedir()));
const leaseMs = integerOption(argv, '--lease-ms', 120_000, 1_000);
const recoveryAfterMs = integerOption(argv, '--recovery-after-ms', 30_000, 0);
const retryAfterMs = integerOption(argv, '--retry-after-ms', 30_000, 1_000);
const nowMs = integerOption(argv, '--now-ms', Date.now(), 0);
const assignment = parseAssignment(assignmentFile);
const heartbeatStaleMs = integerOption(argv, '--heartbeat-stale-ms', Math.max(60_000, assignment.pollIntervalMs * 3), 1_000);

const lease = acquireLease(assignment.archiveDir, nowMs, leaseMs);
if (!lease) {
  process.stdout.write(`${JSON.stringify({ ok: true, status: 'already_running', assignmentId: assignment.assignmentId })}\n`);
  process.exit(0);
}

let result: Record<string, unknown>;
try {
  const admission = validAdmission(assignment);
  if (!admission) {
    result = { ok: true, status: 'waiting_for_admission', assignmentId: assignment.assignmentId };
  } else if (monitoringHealthy(assignment, nowMs, heartbeatStaleMs)) {
    const delivery = sendMonitoringUpdate(assignment, nowMs);
    result = {
      ok: true,
      status: 'monitoring',
      assignmentId: assignment.assignmentId,
      monitoringUpdateSent: delivery.sent,
      receiptPath: delivery.receiptPath,
    };
  } else {
    const admittedAt = Date.parse(String(admission.serverParticipantVerifiedAt ?? ''));
    if (!Number.isFinite(admittedAt)) throw new Error('admission.json has no valid serverParticipantVerifiedAt');
    if (nowMs - admittedAt < recoveryAfterMs) {
      result = { ok: true, status: 'awaiting_monitor_dispatch', assignmentId: assignment.assignmentId };
    } else {
      const recovered = recoverMonitoring(assignmentFile, assignment, nowMs, retryAfterMs);
      result = {
        ok: true,
        status: recovered.runRequested ? 'monitoring_dispatch_recovered' : 'monitoring_dispatch_pending',
        assignmentId: assignment.assignmentId,
        taskId: recovered.taskId,
        dispatchPath: recovered.dispatchPath,
      };
    }
  }
} finally {
  releaseLease(lease);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
