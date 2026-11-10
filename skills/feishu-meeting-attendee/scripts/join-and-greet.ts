#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const DEFAULT_GREETING = '大家好，我是受委托参会的智能体助手，仅做记录与总结，不代表委托人作出承诺；会后我会把会议内容和 TODO 同步给委托人。';
type MeetingMode = 'silent' | 'proxy' | 'assistant';

function usage(): never {
  process.stderr.write('Usage: join-and-greet.ts [<9-digit-meeting-number-or-link>] [--assignment-file FILE] [--mode silent|proxy|assistant] [--intro <text>] [--attendance-timeout-ms N] [--attendance-poll-ms N] [--dry-run]\n');
  process.exit(2);
}

function optionValue(args: string[], name: string): string | undefined {
  const eq = args.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseMode(value: string | undefined): MeetingMode {
  const mode = value ?? 'proxy';
  if (mode !== 'silent' && mode !== 'proxy' && mode !== 'assistant') {
    throw new Error('--mode must be silent, proxy, or assistant');
  }
  return mode;
}

interface AssignmentSnapshot {
  assignmentId: string;
  revision: number;
  meeting: string;
  mode: MeetingMode;
  assigner: string;
  attendeeBotOpenId: string;
  archiveDir: string;
  statusPath: string;
  supervisorTaskId: string;
  monitoringTaskName: string;
}

function readAssignmentSnapshot(path: string): AssignmentSnapshot {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`assignment file is not a JSON object: ${path}`);
  }
  const body = parsed as Record<string, unknown>;
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : '';
  const revision = Number(body.revision);
  const meeting = typeof body.meeting === 'string' ? body.meeting.trim() : '';
  const assigner = typeof body.assigner === 'string' ? body.assigner.trim() : '';
  const attendeeBotOpenId = typeof body.attendeeBotOpenId === 'string' ? body.attendeeBotOpenId.trim() : '';
  const archiveDir = typeof body.archiveDir === 'string' ? resolve(body.archiveDir) : '';
  const statusPath = typeof body.statusPath === 'string' ? resolve(body.statusPath) : '';
  const supervisorTaskId = typeof body.supervisorTaskId === 'string' ? body.supervisorTaskId.trim() : '';
  const monitoringTaskName = typeof body.monitoringTaskName === 'string' ? body.monitoringTaskName.trim() : '';
  const allowedRecipients = Array.isArray(body.allowedRecipients)
    ? body.allowedRecipients.filter((value): value is string => typeof value === 'string')
    : [];
  const destination = body.deliveryDestination && typeof body.deliveryDestination === 'object' && !Array.isArray(body.deliveryDestination)
    ? body.deliveryDestination as Record<string, unknown>
    : undefined;
  const recipientOpenId = typeof destination?.recipientOpenId === 'string' ? destination.recipientOpenId.trim() : '';
  const chatId = typeof destination?.chatId === 'string' ? destination.chatId.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(assignmentId)) {
    throw new Error(`assignment file has an invalid assignmentId: ${path}`);
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`assignment file has an invalid revision: ${path}`);
  }
  if (!meeting) throw new Error(`assignment file has no meeting reference: ${path}`);
  if (!/^ou_[A-Za-z0-9]+$/.test(assigner)) {
    throw new Error(`assignment file has an invalid assigner: ${path}`);
  }
  if (!/^ou_[A-Za-z0-9]+$/.test(attendeeBotOpenId)) {
    throw new Error(`assignment file has an invalid attendeeBotOpenId: ${path}`);
  }
  if (!allowedRecipients.includes(assigner)) throw new Error(`assignment file allowedRecipients does not include assigner: ${path}`);
  if (!/^ou_[A-Za-z0-9]+$/.test(recipientOpenId) || !allowedRecipients.includes(recipientOpenId)) {
    throw new Error(`assignment file has an unapproved delivery recipient: ${path}`);
  }
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error(`assignment file has an invalid delivery chatId: ${path}`);
  if (body.executionIsolation !== 'new-topic') throw new Error(`assignment file must use executionIsolation=new-topic: ${path}`);
  if (!archiveDir || archiveDir !== dirname(resolve(path))) {
    throw new Error(`assignment file archiveDir must be its containing directory: ${path}`);
  }
  if (!statusPath || dirname(statusPath) !== archiveDir || basename(statusPath) !== 'status.json') {
    throw new Error(`assignment file statusPath must be archiveDir/status.json: ${path}`);
  }
  if (!/^[a-f0-9]{8}$/.test(supervisorTaskId)) {
    throw new Error(`assignment file has an invalid supervisorTaskId: ${path}`);
  }
  if (monitoringTaskName !== `feishu-meeting-monitor-${assignmentId}`) {
    throw new Error(`assignment file has a non-deterministic monitoringTaskName: ${path}`);
  }
  return {
    assignmentId,
    revision,
    meeting,
    mode: parseMode(typeof body.mode === 'string' ? body.mode : undefined),
    assigner,
    attendeeBotOpenId,
    archiveDir,
    statusPath,
    supervisorTaskId,
    monitoringTaskName,
  };
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = nonNegativeInteger(value, fallback, name);
  if (parsed < 1) throw new Error(`${name} must be at least 1`);
  return parsed;
}

function atomicWrite(path: string, contents: string): void {
  const tempPath = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tempPath, contents, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
}

function normalizeTimestamp(value: unknown): string | undefined {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!raw || raw === '0') return undefined;
  const numeric = Number(raw);
  const millis = Number.isFinite(numeric) && numeric > 0
    ? numeric * (numeric < 10_000_000_000 ? 1_000 : 1)
    : Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

interface AttendanceResult {
  verified: boolean;
  classification: 'verified' | 'not_found' | 'query_failed';
  proofPath?: string;
  checkPath: string;
  firstJoinTime?: string;
  verifiedAt?: string;
  lastError?: string;
  notificationPath?: string;
}

const ATTENDANCE_INCIDENT_REASONS = [
  'server_attendance_not_found',
  'attendance_verification_query_failed',
] as const;

function attendanceIncidentKey(assignment: AssignmentSnapshot, reason: string): { incidentId: string; dedupKey: string } {
  const incidentId = `attendance:${assignment.assignmentId}:r${assignment.revision}:${reason}`;
  return {
    incidentId,
    dedupKey: createHash('sha256').update(incidentId).digest('hex'),
  };
}

function resolvePendingAttendanceIncidents(assignment: AssignmentSnapshot, resolvedAt: string): void {
  for (const reason of ATTENDANCE_INCIDENT_REASONS) {
    const { dedupKey } = attendanceIncidentKey(assignment, reason);
    const pendingPath = join(assignment.archiveDir, `notification.pending.${dedupKey}.json`);
    if (!existsSync(pendingPath)) continue;
    const resolvedPath = join(assignment.archiveDir, `notification.resolved.${dedupKey}.json`);
    const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as Record<string, unknown>;
    renameSync(pendingPath, resolvedPath);
    atomicWrite(resolvedPath, `${JSON.stringify({
      ...pending,
      status: 'resolved',
      resolution: 'attendance_verified',
      resolvedAt,
    }, null, 2)}\n`);
  }
}

function persistAttendanceFailure(
  assignment: AssignmentSnapshot,
  meetingId: string,
  meetingNo: string,
  classification: 'not_found' | 'query_failed',
  attempts: number,
  lastError?: string,
): AttendanceResult {
  mkdirSync(assignment.archiveDir, { recursive: true, mode: 0o700 });
  chmodSync(assignment.archiveDir, 0o700);
  const checkedAt = new Date().toISOString();
  const checkPath = join(assignment.archiveDir, 'attendance-check.json');
  atomicWrite(checkPath, `${JSON.stringify({
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    assignmentRevision: assignment.revision,
    meetingId,
    meetingNo,
    botOpenId: assignment.attendeeBotOpenId,
    status: classification,
    attempts,
    checkedAt,
    ...(lastError ? { lastError } : {}),
  }, null, 2)}\n`);

  const reason = classification === 'not_found'
    ? 'server_attendance_not_found'
    : 'attendance_verification_query_failed';
  const recommendedAction = classification === 'not_found'
    ? 'Ask the host to confirm agent admission and re-invite the bot if it is absent from the participant list.'
    : 'Retry the read-only server attendance check; do not ask the host to re-invite solely because verification could not be queried.';
  const { incidentId, dedupKey } = attendanceIncidentKey(assignment, reason);
  const pendingPath = join(assignment.archiveDir, `notification.pending.${dedupKey}.json`);
  const sentPath = join(assignment.archiveDir, `notification.sent.${dedupKey}.json`);
  if (!existsSync(pendingPath) && !existsSync(sentPath)) {
    atomicWrite(pendingPath, `${JSON.stringify({
      schemaVersion: 1,
      status: 'action_required',
      reason,
      assignerRef: assignment.assigner,
      recommendedAction,
      createdAt: checkedAt,
      incidentId,
      dedupKey,
    }, null, 2)}\n`);
  }
  return {
    verified: false,
    classification,
    checkPath,
    ...(lastError ? { lastError } : {}),
    notificationPath: existsSync(pendingPath) ? pendingPath : sentPath,
  };
}

async function verifyAndPersistAttendance(
  assignment: AssignmentSnapshot,
  meetingId: string,
  meetingNo: string,
  timeoutMs: number,
  pollMs: number,
): Promise<AttendanceResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError: string | undefined;
  let sawSuccessfulQuery = false;
  do {
    attempts += 1;
    try {
      const raw = runLarkJson([
        'vc', 'meeting', 'get', '--as', 'bot', '--meeting-id', meetingId,
        '--with-participants', '--format', 'json',
      ]);
      const body = assertLarkOk(raw, 'attendance verification');
      const data = objectAt(body, 'data');
      const meeting = objectAt(data, 'meeting');
      const returnedMeetingId = typeof meeting?.id === 'string' ? meeting.id.trim() : '';
      const returnedMeetingNo = typeof meeting?.meeting_no === 'string' ? meeting.meeting_no.trim() : '';
      if (returnedMeetingId && returnedMeetingId !== meetingId) {
        throw new Error('attendance verification returned a different meeting.id');
      }
      if (returnedMeetingNo && returnedMeetingNo !== meetingNo) {
        throw new Error('attendance verification returned a different meeting number');
      }
      sawSuccessfulQuery = true;
      const participants = Array.isArray(meeting?.participants) ? meeting.participants : [];
      const participant = participants.find(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const item = value as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        const status = Number(item.status);
        const finalLeaveTime = String(item.final_leave_time ?? '').trim();
        return id === assignment.attendeeBotOpenId
          && (status === 2 || (!Number.isFinite(status) && (!finalLeaveTime || finalLeaveTime === '0')));
      }) as Record<string, unknown> | undefined;
      if (participant) {
        const latest = readAssignmentSnapshot(assignmentFile!);
        if (latest.assignmentId !== assignment.assignmentId
          || latest.revision < assignment.revision
          || latest.meeting !== assignment.meeting
          || latest.attendeeBotOpenId !== assignment.attendeeBotOpenId
          || latest.archiveDir !== assignment.archiveDir) {
          throw new Error('assignment identity changed before attendance proof persistence');
        }
        mkdirSync(latest.archiveDir, { recursive: true, mode: 0o700 });
        chmodSync(latest.archiveDir, 0o700);
        const verifiedAt = new Date().toISOString();
        const firstJoinTime = normalizeTimestamp(participant.first_join_time);
        const proofPath = join(latest.archiveDir, 'attendance-proof.json');
        const checkPath = join(latest.archiveDir, 'attendance-check.json');
        atomicWrite(proofPath, `${JSON.stringify({
          schemaVersion: 1,
          assignmentId: latest.assignmentId,
          assignmentRevision: latest.revision,
          meetingId,
          meetingNo,
          botOpenId: latest.attendeeBotOpenId,
          status: 'joined',
          ...(firstJoinTime ? { firstJoinTime } : {}),
          verifiedAt,
          source: 'lark-cli vc meeting get --as bot --with-participants',
        }, null, 2)}\n`);
        atomicWrite(checkPath, `${JSON.stringify({
          schemaVersion: 1,
          assignmentId: latest.assignmentId,
          assignmentRevision: latest.revision,
          meetingId,
          meetingNo,
          botOpenId: latest.attendeeBotOpenId,
          status: 'verified',
          attempts,
          checkedAt: verifiedAt,
        }, null, 2)}\n`);
        resolvePendingAttendanceIncidents(latest, verifiedAt);
        return { verified: true, classification: 'verified', proofPath, checkPath, verifiedAt, ...(firstJoinTime ? { firstJoinTime } : {}) };
      }
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(pollMs, remaining));
  } while (true);

  return persistAttendanceFailure(
    assignment,
    meetingId,
    meetingNo,
    sawSuccessfulQuery ? 'not_found' : 'query_failed',
    attempts,
    lastError,
  );
}

function meetingNumberFrom(value: string): string | undefined {
  const decoded = (() => {
    try { return decodeURIComponent(value); } catch { return value; }
  })();
  return decoded.match(/(?:^|\D)(\d{9})(?:\D|$)/)?.[1];
}

function stableGreetingUuid(meetingId: string, greeting: string): string {
  const chars = createHash('sha256')
    .update(`botmux-feishu-meeting-attendee:greeting:v2:${meetingId}:${greeting}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  chars[12] = '5';
  chars[16] = '8';
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function runLarkJson(args: string[]): unknown {
  const result = spawnSync('lark-cli', args, {
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `lark-cli exited ${result.status}`).trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`lark-cli returned non-JSON output: ${result.stdout.slice(0, 500)}`);
  }
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
}

function assertLarkOk(raw: unknown, operation: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${operation} returned an invalid response`);
  }
  const body = raw as Record<string, unknown>;
  if (body.ok === false || (body.code !== undefined && body.code !== 0 && body.code !== '0')) {
    const error = objectAt(body, 'error');
    const nested = error ? objectAt(error, 'error') ?? objectAt(error, 'detail') : undefined;
    const code = error?.code ?? body.code;
    const nestedCode = nested?.code;
    const subtype = error?.subtype ?? error?.type;
    const message = error?.message ?? body.message ?? body.msg ?? `${operation} failed`;
    const details = [
      `${operation} failed`,
      code !== undefined ? `code=${String(code)}` : undefined,
      nestedCode !== undefined ? `nestedCode=${String(nestedCode)}` : undefined,
      subtype !== undefined ? `subtype=${String(subtype)}` : undefined,
      String(message),
    ].filter(Boolean);
    throw new Error(details.join(' '));
  }
  return body;
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const assignmentFileOption = optionValue(argv, '--assignment-file')?.trim();
const assignmentFile = assignmentFileOption
  ? resolve(assignmentFileOption.replace(/^~(?=\/|$)/, homedir()))
  : undefined;
const initialAssignment = assignmentFile ? readAssignmentSnapshot(assignmentFile) : undefined;
if (initialAssignment && optionValue(argv, '--mode') !== undefined) {
  throw new Error('--mode cannot be combined with --assignment-file; update the assignment revision instead');
}
let mode = initialAssignment?.mode ?? parseMode(optionValue(argv, '--mode'));
const attendanceTimeoutMs = nonNegativeInteger(optionValue(argv, '--attendance-timeout-ms'), 180_000, '--attendance-timeout-ms');
const attendancePollMs = positiveInteger(optionValue(argv, '--attendance-poll-ms'), 5_000, '--attendance-poll-ms');
const customIntro = optionValue(argv, '--intro')?.trim();
if (customIntro && customIntro.length > 500) throw new Error('--intro must be at most 500 characters');
const greeting = customIntro || DEFAULT_GREETING;
const optionIndexes = new Set<number>();
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--dry-run'
    || argv[i].startsWith('--mode=')
    || argv[i].startsWith('--intro=')
    || argv[i].startsWith('--assignment-file=')
    || argv[i].startsWith('--attendance-timeout-ms=')
    || argv[i].startsWith('--attendance-poll-ms=')) optionIndexes.add(i);
  if (argv[i] === '--mode'
    || argv[i] === '--intro'
    || argv[i] === '--assignment-file'
    || argv[i] === '--attendance-timeout-ms'
    || argv[i] === '--attendance-poll-ms') { optionIndexes.add(i); optionIndexes.add(i + 1); }
}
const reference = argv.find((_, index) => !optionIndexes.has(index)) ?? initialAssignment?.meeting;
if (!reference) usage();

const meetingNo = meetingNumberFrom(reference);
if (!meetingNo) {
  throw new Error('A joinable 9-digit Feishu meeting number or a meeting link containing it is required; an internal meeting.id alone cannot be joined.');
}
if (initialAssignment && meetingNumberFrom(initialAssignment.meeting) !== meetingNo) {
  throw new Error('the positional meeting reference does not match --assignment-file');
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dryRun: true,
    meetingNo,
    mode,
    ...(initialAssignment ? {
      assignmentId: initialAssignment.assignmentId,
      assignmentRevision: initialAssignment.revision,
    } : {}),
    join: ['lark-cli', 'vc', '+meeting-join', '--as', 'bot', '--meeting-number', meetingNo, '--json'],
    greeting: mode === 'silent' ? null : greeting,
  }, null, 2)}\n`);
  process.exit(0);
}

const joinedRaw = runLarkJson([
  'vc', '+meeting-join', '--as', 'bot', '--meeting-number', meetingNo, '--json',
]);
const joined = assertLarkOk(joinedRaw, 'meeting join');
const data = objectAt(joined, 'data');
const meeting = objectAt(data, 'meeting');
const meetingId = typeof meeting?.id === 'string' ? meeting.id.trim() : '';
if (!meetingId) throw new Error('Meeting join succeeded but the response did not include meeting.id');

let appliedAssignment = initialAssignment;
if (assignmentFile && initialAssignment) {
  try {
    const latest = readAssignmentSnapshot(assignmentFile);
    if (latest.assignmentId !== initialAssignment.assignmentId) {
      throw new Error('assignmentId changed after the meeting join');
    }
    if (latest.revision < initialAssignment.revision) {
      throw new Error('assignment revision moved backwards after the meeting join');
    }
    if (meetingNumberFrom(latest.meeting) !== meetingNo) {
      throw new Error('meeting reference changed after the meeting join');
    }
    if (latest.attendeeBotOpenId !== initialAssignment.attendeeBotOpenId
      || latest.archiveDir !== initialAssignment.archiveDir) {
      throw new Error('assignment identity changed after the meeting join');
    }
    if (latest.supervisorTaskId !== initialAssignment.supervisorTaskId) {
      throw new Error('supervisorTaskId changed or disappeared after the meeting join');
    }
    if (latest.monitoringTaskName !== initialAssignment.monitoringTaskName) {
      throw new Error('monitoringTaskName changed or disappeared after the meeting join');
    }
    appliedAssignment = latest;
    mode = latest.mode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      joined: true,
      greetingOutcome: 'not_attempted_assignment_reload_failed',
      mode,
      meetingId,
      meetingNo,
      assignmentId: initialAssignment.assignmentId,
      assignmentRevision: initialAssignment.revision,
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exit(3);
  }
}

if (!appliedAssignment || !assignmentFile) {
  throw new Error('--assignment-file is required for durable attendance verification');
}
const attendance = await verifyAndPersistAttendance(
  appliedAssignment,
  meetingId,
  meetingNo,
  attendanceTimeoutMs,
  attendancePollMs,
);
if (!attendance.verified) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    joined: true,
    greeted: false,
    greetingOutcome: 'not_attempted_attendance_unverified',
    attendanceVerified: false,
    attendanceClassification: attendance.classification,
    attendanceCheckPath: attendance.checkPath,
    notificationPendingPath: attendance.notificationPath,
    mode,
    meetingId,
    meetingNo,
    assignmentId: appliedAssignment.assignmentId,
    assignmentRevision: appliedAssignment.revision,
    ...(attendance.lastError ? { error: attendance.lastError } : {}),
  }, null, 2)}\n`);
  process.exit(4);
}

function persistAdmission(greetingOutcome: 'silent_not_required' | 'sent' | 'uncertain_do_not_retry'): string {
  const path = join(appliedAssignment.archiveDir, 'admission.json');
  atomicWrite(path, `${JSON.stringify({
    schemaVersion: 1,
    assignmentId: appliedAssignment.assignmentId,
    assignmentRevision: appliedAssignment.revision,
    meetingId,
    meetingNo,
    botOpenId: appliedAssignment.attendeeBotOpenId,
    mode,
    greetingOutcome,
    serverParticipantVerifiedAt: attendance.verifiedAt,
    ...(attendance.firstJoinTime ? { firstJoinTime: attendance.firstJoinTime } : {}),
    attendanceProofPath: attendance.proofPath,
  }, null, 2)}\n`);
  return path;
}

if (mode === 'silent') {
  const admissionPath = persistAdmission('silent_not_required');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    joined: true,
    greeted: false,
    mode,
    meetingId,
    meetingNo,
    attendanceVerified: true,
    attendanceProofPath: attendance.proofPath,
    serverParticipantVerified: true,
    admissionWritten: true,
    admissionPath,
    ...(attendance.firstJoinTime ? { firstJoinTime: attendance.firstJoinTime } : {}),
    ...(appliedAssignment ? {
      assignmentId: appliedAssignment.assignmentId,
      assignmentRevision: appliedAssignment.revision,
    } : {}),
  }, null, 2)}\n`);
  process.exit(0);
}

const greetingUuid = stableGreetingUuid(meetingId, greeting);
let greetingRaw: unknown;
try {
  greetingRaw = runLarkJson([
    'vc', '+meeting-message-send', '--as', 'bot', '--meeting-id', meetingId,
    '--msg-type', 'text', '--text', greeting, '--uuid', greetingUuid, '--json',
  ]);
  assertLarkOk(greetingRaw, 'meeting greeting');
} catch (error) {
  const admissionPath = persistAdmission('uncertain_do_not_retry');
  process.stderr.write(`${JSON.stringify({
    ok: false,
    joined: true,
    greetingOutcome: 'uncertain_or_failed_do_not_retry',
    mode,
    meetingId,
    meetingNo,
    attendanceVerified: true,
    serverParticipantVerified: true,
    admissionWritten: true,
    admissionPath,
    ...(appliedAssignment ? {
      assignmentId: appliedAssignment.assignmentId,
      assignmentRevision: appliedAssignment.revision,
    } : {}),
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exit(3);
}

const admissionPath = persistAdmission('sent');

process.stdout.write(`${JSON.stringify({
  ok: true,
  joined: true,
  greeted: true,
  mode,
  meetingId,
  meetingNo,
  attendanceVerified: true,
  attendanceProofPath: attendance.proofPath,
  serverParticipantVerified: true,
  admissionWritten: true,
  admissionPath,
  ...(attendance.firstJoinTime ? { firstJoinTime: attendance.firstJoinTime } : {}),
  greetingUuid,
  greeting,
  ...(appliedAssignment ? {
    assignmentId: appliedAssignment.assignmentId,
    assignmentRevision: appliedAssignment.revision,
  } : {}),
}, null, 2)}\n`);
