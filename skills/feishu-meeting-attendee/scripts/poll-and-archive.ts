#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

interface CursorState {
  schemaVersion: 1;
  committedBatch: number;
  pageToken?: string;
  updatedAt: string;
  lastSuccessfulPollAt?: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  payload?: unknown;
}

interface ProviderProblem {
  stage: 'meeting-events';
  code?: string;
  nestedCode?: string;
  subtype?: string;
  message: string;
  classification: 'meeting_ended' | 'action_required' | 'invalid_meeting' | 'retryable';
  retryable: boolean;
}

interface ArchivedEventRecord {
  schemaVersion: 1;
  source: 'polling';
  batch: number;
  receivedAt: string;
  eventVersionKey: string;
  event: unknown;
}

const argv = process.argv.slice(2);

function option(name: string): string | undefined {
  const direct = argv.indexOf(name);
  if (direct >= 0) return argv[direct + 1];
  const withEquals = argv.find(arg => arg.startsWith(`${name}=`));
  return withEquals?.slice(name.length + 1);
}

function positiveNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function positionalMeetingId(): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      if (!arg.includes('=')) index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

const meetingId = positionalMeetingId()?.trim();
if (!meetingId) {
  process.stderr.write('Usage: poll-and-archive.ts <meetingId> [--assigner-ref ou_...] [--archive-dir DIR] [--poll-ms N] [--max-hours N] [--max-polls N] [--profile NAME]\n');
  process.exit(2);
}

const pollMs = positiveNumber('--poll-ms', 5_000, 1_000, 300_000);
const maxHours = positiveNumber('--max-hours', 4, 0.01, 48);
const maxPolls = Math.floor(positiveNumber('--max-polls', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER));
const maxConsecutiveFailures = Math.floor(positiveNumber('--max-consecutive-failures', 5, 1, 20));
const profile = option('--profile')?.trim();
const assignerRef = option('--assigner-ref')?.trim();
if (assignerRef && !/^ou_[A-Za-z0-9]+$/.test(assignerRef)) {
  throw new Error('--assigner-ref must be a verified Feishu open_id');
}
const explicitArchiveDir = option('--archive-dir');
const meetingKey = createHash('sha256').update(meetingId).digest('hex').slice(0, 20);
const archiveDir = resolve(explicitArchiveDir
  ? explicitArchiveDir.replace(/^~(?=\/|$)/, homedir())
  : join(homedir(), '.botmux', 'data', 'vc-meeting-archives', meetingKey));
const rawDir = join(archiveDir, 'raw');
const cursorPath = join(archiveDir, 'cursor.json');
const eventsPath = join(archiveDir, 'events.ndjson');
const errorPath = join(archiveDir, 'errors.ndjson');
const logPath = join(archiveDir, 'poll.ndjson');
const finalPath = join(archiveDir, 'final.json');
const lockPath = join(archiveDir, '.poll.lock');
const lockGuardPath = join(archiveDir, '.poll.lock.takeover');
const lockGuardOwnerPath = join(lockGuardPath, 'owner.json');
const tornTailPath = join(archiveDir, 'torn-tail.log');
const probePath = join(archiveDir, 'probes.ndjson');
const pollerStartedAt = new Date().toISOString();
const deadline = Date.now() + maxHours * 60 * 60 * 1_000;

mkdirSync(rawDir, { recursive: true, mode: 0o700 });
chmodSync(archiveDir, 0o700);
chmodSync(rawDir, 0o700);

interface LockOwnership {
  fd: number;
  ownerToken: string;
}

interface GuardOwnership {
  ownerToken: string;
}

class AlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyRunningError';
  }
}

class LockInterventionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockInterventionError';
  }
}

let lockOwnership: LockOwnership | undefined;

function appendPrivate(path: string, line: string): void {
  appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function log(level: 'info' | 'warn' | 'alert', event: string, details: JsonRecord = {}): void {
  appendPrivate(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  }) + '\n');
}

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

interface NotificationReceipt {
  path: string;
  dedupKey: string;
  persisted: boolean;
}

function persistPendingNotification(
  status: 'action_required' | 'invalid_meeting',
  reason: string,
  recommendedAction: string,
): NotificationReceipt {
  const incidentId = `${pollerStartedAt}:${cursor.committedBatch}`;
  const dedupKey = createHash('sha256')
    .update([meetingKey, status, reason, assignerRef ?? 'unresolved', incidentId].join('\n'))
    .digest('hex');
  const notificationPendingPath = join(archiveDir, `notification.pending.${dedupKey}.json`);
  const createdAt = new Date().toISOString();
  const payload = JSON.stringify({
    schemaVersion: 1,
    status,
    reason: reason.slice(0, 2_000),
    assignerRef: assignerRef ?? null,
    recommendedAction,
    createdAt,
    incidentId,
    dedupKey,
  }, null, 2) + '\n';
  const temp = `${notificationPendingPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      linkSync(temp, notificationPendingPath);
      chmodSync(notificationPendingPath, 0o600);
      return { path: notificationPendingPath, dedupKey, persisted: true };
    } catch (error) {
      const code = isRecord(error) ? text(error.code) : undefined;
      if (code === 'EEXIST') {
        try {
          const existing: unknown = JSON.parse(readFileSync(notificationPendingPath, 'utf8'));
          const existingDedupKey = isRecord(existing) ? text(existing.dedupKey) : undefined;
          return {
            path: notificationPendingPath,
            dedupKey: existingDedupKey ?? dedupKey,
            persisted: !!existingDedupKey,
          };
        } catch {
          return { path: notificationPendingPath, dedupKey, persisted: false };
        }
      }
      return { path: notificationPendingPath, dedupKey, persisted: false };
    }
  } catch {
    return { path: notificationPendingPath, dedupKey, persisted: false };
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // The hard-linked pending record, when present, remains intact.
    }
  }
}

function emitResult(result: JsonRecord): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = isRecord(error) ? text(error.code) : undefined;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

function readOwnerPid(value: unknown): number | undefined {
  return isRecord(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
    ? Number(value.pid)
    : undefined;
}

function inspectContendedGuard(): never {
  let owner: unknown;
  try {
    owner = JSON.parse(readFileSync(lockGuardOwnerPath, 'utf8'));
  } catch (error) {
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - statSync(lockGuardPath).mtimeMs;
    } catch {
      throw new AlreadyRunningError('archive lock guard changed during contention; retry later');
    }
    if (ageMs < 5_000) {
      throw new AlreadyRunningError('another poller is initializing the archive lock guard');
    }
    throw new LockInterventionError(`archive lock guard is stale or unreadable; manual review required: ${lockGuardPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pid = readOwnerPid(owner);
  if (!pid) throw new LockInterventionError(`archive lock guard has no valid pid; manual review required: ${lockGuardPath}`);
  if (processExists(pid)) {
    throw new AlreadyRunningError(`another poller (pid ${pid}) is acquiring or taking over the archive lock`);
  }
  throw new LockInterventionError(`archive lock guard belongs to dead pid ${pid}; manual review required: ${lockGuardPath}`);
}

function acquireLockGuard(): GuardOwnership {
  const ownerToken = randomUUID();
  try {
    mkdirSync(lockGuardPath, { mode: 0o700 });
  } catch (error) {
    const code = isRecord(error) ? text(error.code) : undefined;
    if (code === 'EEXIST') inspectContendedGuard();
    throw new LockInterventionError(`cannot acquire archive lock guard ${lockGuardPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    writeFileSync(lockGuardOwnerPath, JSON.stringify({
      pid: process.pid,
      ownerToken,
      startedAt: new Date().toISOString(),
    }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { ownerToken };
  } catch (error) {
    try {
      rmdirSync(lockGuardPath);
    } catch {
      // Leave unexpected state for manual review.
    }
    throw new LockInterventionError(`cannot initialize archive lock guard ${lockGuardPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function releaseLockGuard(ownership: GuardOwnership): void {
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(lockGuardOwnerPath, 'utf8'));
  } catch {
    return;
  }
  if (!isRecord(current)
    || current.pid !== process.pid
    || current.ownerToken !== ownership.ownerToken) return;
  try {
    unlinkSync(lockGuardOwnerPath);
    rmdirSync(lockGuardPath);
  } catch {
    // A stranded guard is safer than removing another process's state.
  }
}

function acquireArchiveLock(): LockOwnership {
  const create = (): LockOwnership => {
    const ownerToken = randomUUID();
    const fd = openSync(lockPath, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        ownerToken,
        startedAt: new Date().toISOString(),
      }) + '\n');
      return { fd, ownerToken };
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  };

  const guardOwnership = acquireLockGuard();

  try {
    if (!existsSync(lockPath)) return create();

    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch (error) {
      throw new LockInterventionError(`archive lock exists but is unreadable; manual review required: ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pid = isRecord(owner) && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0
      ? Number(owner.pid)
      : undefined;
    if (!pid) throw new LockInterventionError(`archive lock has no valid pid; manual review required: ${lockPath}`);
    if (processExists(pid)) {
      throw new AlreadyRunningError(`another archive poller (pid ${pid}) owns ${lockPath}; PID reuse also fails closed intentionally`);
    }

    const stalePath = `${lockPath}.stale-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    renameSync(lockPath, stalePath);
    const ownership = create();
    try {
      log('warn', 'stale_lock_taken_over', { previousPid: pid, preservedAt: stalePath });
    } catch {
      // Lock ownership is already established; logging failure must not leak it.
    }
    return ownership;
  } finally {
    releaseLockGuard(guardOwnership);
  }
}

function releaseArchiveLock(ownership: LockOwnership): void {
  closeSync(ownership.fd);
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return;
  }
  if (isRecord(current)
    && current.pid === process.pid
    && current.ownerToken === ownership.ownerToken) {
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale own lock is safer than deleting an unexpected path.
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.search(/[\[{]/);
    if (objectStart < 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(objectStart));
    } catch {
      return undefined;
    }
  }
}

function providerPayload(result: CommandResult): unknown | undefined {
  const stdoutPayload = parseJson(result.stdout);
  const stderrPayload = parseJson(result.stderr);
  if (isRecord(stderrPayload) && stderrPayload.ok === false) return stderrPayload;
  if (isRecord(stdoutPayload)) return stdoutPayload;
  return stderrPayload ?? stdoutPayload;
}

async function runLarkCli(args: string[]): Promise<CommandResult> {
  const executable = process.env.FEISHU_MEETING_LARK_CLI?.trim() || 'lark-cli';
  const child = Bun.spawn([executable, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result: CommandResult = { exitCode, stdout, stderr };
  result.payload = providerPayload(result);
  return result;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function providerProblem(result: CommandResult): ProviderProblem | undefined {
  const body = isRecord(result.payload) ? result.payload : undefined;
  const error = body && isRecord(body.error) ? body.error : undefined;
  const nested = error && isRecord(error.error)
    ? error.error
    : error && isRecord(error.detail)
      ? error.detail
      : undefined;
  const structuredCode = text(body?.code ?? error?.code);
  const structuredNestedCode = text(nested?.code);
  const fallbackCode = `${result.stderr}\n${result.stdout}`.match(/\b(122001|20001|20002|10005|121\d{3})\b/)?.[1];
  const code = structuredCode ?? (!structuredNestedCode ? fallbackCode : undefined);
  const nestedCode = structuredNestedCode;
  const subtype = text(error?.subtype ?? error?.type);
  const message = text(error?.message ?? error?.msg ?? body?.message ?? body?.msg)
    ?? text(result.stderr)
    ?? text(result.stdout)
    ?? `lark-cli exited ${result.exitCode}`;
  const failed = result.exitCode !== 0
    || !body
    || body?.ok === false
    || (code !== undefined && code !== '0');
  if (!failed) return undefined;

  const codes = new Set([code, nestedCode].filter((value): value is string => !!value));
  let classification: ProviderProblem['classification'] = 'retryable';
  if (codes.has('122001') || codes.has('20001')) classification = 'meeting_ended';
  else if (codes.has('20002')) classification = 'invalid_meeting';
  else if (codes.has('10005') || [...codes].some(value => /^121\d{3}$/.test(value))) classification = 'action_required';

  return {
    stage: 'meeting-events',
    ...(code ? { code } : {}),
    ...(nestedCode ? { nestedCode } : {}),
    ...(subtype ? { subtype } : {}),
    message: message.slice(0, 2_000),
    classification,
    retryable: classification === 'retryable',
  };
}

function unwrapData(payload: unknown): JsonRecord | undefined {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.data)) return payload.data;
  return payload;
}

function extractEvents(payload: unknown): unknown[] {
  const data = unwrapData(payload);
  return Array.isArray(data?.events) ? data.events : [];
}

function extractPageToken(payload: unknown): string | undefined {
  const data = unwrapData(payload);
  return text(data?.page_token ?? data?.pageToken);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function eventVersionKey(event: unknown): string {
  const hash = createHash('sha256').update(stableJson(event)).digest('hex');
  const eventId = isRecord(event) ? text(event.event_id ?? event.eventId) : undefined;
  return eventId ? `${eventId}:${hash}` : `hash:${hash}`;
}

function loadSeenEventVersions(): Set<string> {
  if (!existsSync(eventsPath)) return new Set();
  let contents = readFileSync(eventsPath, 'utf8');
  const endedWithNewline = contents.endsWith('\n');
  const lines = contents.split('\n');
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Partial<ArchivedEventRecord>;
      if (typeof record.eventVersionKey === 'string') seen.add(record.eventVersionKey);
    } catch {
      const isTornTail = !endedWithNewline && index === lines.length - 1;
      if (isTornTail) {
        const lastNewline = contents.lastIndexOf('\n');
        const validPrefix = lastNewline >= 0 ? contents.slice(0, lastNewline + 1) : '';
        const fragment = lastNewline >= 0 ? contents.slice(lastNewline + 1) : contents;
        truncateSync(eventsPath, Buffer.byteLength(validPrefix, 'utf8'));
        appendPrivate(tornTailPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          event: 'torn_tail_truncated',
          byteCount: Buffer.byteLength(fragment, 'utf8'),
          sha256: createHash('sha256').update(fragment).digest('hex'),
        }) + '\n');
        log('warn', 'torn_event_tail_recovered', {
          byteCount: Buffer.byteLength(fragment, 'utf8'),
        });
        contents = validPrefix;
        break;
      }
      throw new Error(`archive event ledger is corrupt: ${eventsPath}`);
    }
  }
  return seen;
}

function loadCursor(): CursorState {
  if (!existsSync(cursorPath)) {
    return { schemaVersion: 1, committedBatch: 0, updatedAt: new Date(0).toISOString() };
  }
  const parsed: unknown = JSON.parse(readFileSync(cursorPath, 'utf8'));
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || !Number.isSafeInteger(parsed.committedBatch)
    || Number(parsed.committedBatch) < 0
    || typeof parsed.updatedAt !== 'string') {
    throw new Error(`archive cursor is invalid: ${cursorPath}`);
  }
  return {
    schemaVersion: 1,
    committedBatch: Number(parsed.committedBatch),
    ...(text(parsed.pageToken) ? { pageToken: text(parsed.pageToken) } : {}),
    updatedAt: parsed.updatedAt,
    ...(text(parsed.lastSuccessfulPollAt) ? { lastSuccessfulPollAt: text(parsed.lastSuccessfulPollAt) } : {}),
  };
}

function maxRawSequence(): number {
  let max = 0;
  for (const entry of readdirSync(rawDir)) {
    const match = /^(\d+)-/.exec(entry);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

interface MeetingProbe {
  classification: 'ended' | 'active' | 'inconclusive';
  endedAt?: string;
  message: string;
}

function normalizeTimestamp(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const numeric = Number(raw);
  const millis = Number.isFinite(numeric) && numeric > 0
    ? numeric * (numeric < 10_000_000_000 ? 1_000 : 1)
    : Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function findMeetingFacts(value: unknown, facts: { statuses: string[]; endedAt?: string }): void {
  if (Array.isArray(value)) {
    for (const item of value) findMeetingFacts(item, facts);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'status' || normalizedKey === 'meeting_status') {
      const status = text(nested)?.toLowerCase();
      if (status) facts.statuses.push(status);
    } else if (normalizedKey === 'end_time' || normalizedKey === 'endtime' || normalizedKey === 'ended_at') {
      facts.endedAt ??= normalizeTimestamp(nested);
    } else {
      findMeetingFacts(nested, facts);
    }
  }
}

async function probeMeetingState(reason: string): Promise<MeetingProbe> {
  const checkedAt = new Date().toISOString();
  const result = await runLarkCli([
    'vc', 'meeting', 'get', '--as', 'bot', '--meeting-id', meetingId,
    '--with-participants', '--format', 'json',
    ...(profile ? ['--profile', profile] : []),
  ]);
  appendPrivate(probePath, JSON.stringify({
    timestamp: checkedAt,
    reason,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    payload: result.payload,
  }) + '\n');

  const problem = providerProblem(result);
  if (problem?.classification === 'meeting_ended') {
    return { classification: 'ended', message: problem.message };
  }
  if (problem) {
    return { classification: 'inconclusive', message: problem.message };
  }

  const facts: { statuses: string[]; endedAt?: string } = { statuses: [] };
  findMeetingFacts(result.payload, facts);
  const ended = !!facts.endedAt || facts.statuses.some(status => /ended|finished|completed|closed/.test(status));
  if (ended) {
    return {
      classification: 'ended',
      ...(facts.endedAt ? { endedAt: facts.endedAt } : {}),
      message: `meeting probe reports ended (${facts.statuses.join(',') || 'end_time present'})`,
    };
  }
  return {
    classification: result.exitCode === 0 ? 'active' : 'inconclusive',
    message: result.exitCode === 0
      ? `meeting exists but event polling remains unavailable (${facts.statuses.join(',') || 'status unavailable'})`
      : 'meeting probe was inconclusive',
  };
}

function findTranscriptItems(value: unknown, output: JsonRecord[]): void {
  if (Array.isArray(value)) {
    for (const item of value) findTranscriptItems(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'transcript_received_items' || key === 'transcriptReceivedItems') && Array.isArray(nested)) {
      for (const item of nested) if (isRecord(item)) output.push(item);
      continue;
    }
    findTranscriptItems(nested, output);
  }
}

function finalize(reason: string, status: 'ended' | 'partial' | 'action_required' | 'invalid_meeting'): void {
  const records: ArchivedEventRecord[] = [];
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line) as ArchivedEventRecord);
    }
  }
  const latestTranscripts = new Map<string, JsonRecord>();
  for (const record of records) {
    const transcriptItems: JsonRecord[] = [];
    findTranscriptItems(record.event, transcriptItems);
    for (const item of transcriptItems) {
      const sentenceId = text(item.sentence_id ?? item.sentenceId);
      if (sentenceId) latestTranscripts.set(sentenceId, item);
    }
  }
  const rawBatches = readdirSync(rawDir).filter(name => name.endsWith('.json')).length;
  const lastSuccessfulPollAt = cursor.lastSuccessfulPollAt;
  const tailGapSeconds = meetingEndedAt && lastSuccessfulPollAt
    ? Math.max(0, Math.ceil((Date.parse(meetingEndedAt) - Date.parse(lastSuccessfulPollAt)) / 1_000))
    : undefined;
  const coverageNote = status === 'ended'
    ? tailGapSeconds !== undefined
      ? `Meeting end was confirmed, but polling-only capture cannot prove a complete tail; measured end-to-last-success gap is ${tailGapSeconds}s.`
      : 'Meeting end was confirmed, but the end time or last successful poll time is unavailable; polling-only capture cannot prove complete tail coverage.'
    : 'Partial or interrupted capture; report this coverage gap and use an authorized original transcript source if available.';
  atomicWrite(finalPath, JSON.stringify({
    schemaVersion: 1,
    meetingKey,
    status,
    reason,
    finalizedAt: new Date().toISOString(),
    rawBatches,
    archivedEventVersions: records.length,
    transcript: [...latestTranscripts.values()],
    coverage: {
      complete: false,
      ...(lastSuccessfulPollAt ? { lastSuccessfulPollAt } : {}),
      ...(meetingEndedAt ? { meetingEndedAt } : {}),
      ...(tailGapSeconds !== undefined ? { tailGapSeconds } : {}),
      note: coverageNote,
    },
  }, null, 2) + '\n');
  log(status === 'ended' ? 'info' : 'alert', 'finalized', {
    status,
    reason,
    rawBatches,
    archivedEventVersions: records.length,
    transcriptSentences: latestTranscripts.size,
  });
  const requiresNotification = status === 'action_required' || status === 'invalid_meeting';
  const recommendedAction = status === 'invalid_meeting'
    ? 'Verify the meeting identifier and access, then restart attendance with the same private archive directory when corrected.'
    : 'Notify the verified assigner privately. After the host re-invites the bot or restores agent access, rerun join-and-greet and poll-and-archive with the same archive directory so polling resumes from the committed cursor.';
  const notification = requiresNotification
    ? persistPendingNotification(status, reason, recommendedAction)
    : undefined;
  emitResult({
    ok: status === 'ended' || status === 'partial',
    status,
    reason,
    archiveDir,
    finalPath,
    rawBatches,
    archivedEventVersions: records.length,
    transcriptSentences: latestTranscripts.size,
    requiresNotification,
    ...(requiresNotification ? {
      recommendedAction,
      notificationPendingPath: notification?.path,
      notificationDedupKey: notification?.dedupKey,
      notificationPersisted: notification?.persisted,
    } : {}),
  });
}

let cursor: CursorState = { schemaVersion: 1, committedBatch: 0, updatedAt: new Date(0).toISOString() };
let rawSequence = 0;
let seenEventVersions = new Set<string>();
let meetingEndedAt: string | undefined;
let consecutiveFailures = 0;
let polls = 0;
let finalized = false;

async function main(): Promise<void> {
  log('info', 'polling_started', {
    meetingKey,
    pollMs,
    maxHours,
    maxConsecutiveFailures,
    resumePageToken: cursor.pageToken ?? null,
    committedBatch: cursor.committedBatch,
  });

  while (Date.now() < deadline && polls < maxPolls) {
    polls += 1;
    const args = [
      'vc', '+meeting-events', '--as', 'bot', '--meeting-id', meetingId,
      '--page-all', '--format', 'json',
      ...(cursor.pageToken ? ['--page-token', cursor.pageToken] : []),
      ...(profile ? ['--profile', profile] : []),
    ];
    const receivedAt = new Date().toISOString();
    const result = await runLarkCli(args);
    rawSequence += 1;
    const rawName = `${String(rawSequence).padStart(8, '0')}-${receivedAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    writeFileSync(join(rawDir, rawName), JSON.stringify({
      schemaVersion: 1,
      receivedAt,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      payload: result.payload,
    }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const problem = providerProblem(result);
    if (problem) {
      appendPrivate(errorPath, JSON.stringify({ timestamp: receivedAt, ...problem }) + '\n');
      log(problem.retryable ? 'warn' : 'alert', 'provider_problem', problem as unknown as JsonRecord);
      if (!problem.retryable) {
        const status = problem.classification === 'meeting_ended'
          ? 'ended'
          : problem.classification === 'invalid_meeting'
            ? 'invalid_meeting'
            : 'action_required';
        if (status === 'ended') {
          try {
            const probe = await probeMeetingState('terminal_event_response');
            meetingEndedAt = probe.endedAt;
          } catch (error) {
            log('warn', 'terminal_probe_failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        finalize(`${problem.code ?? problem.nestedCode ?? problem.classification}: ${problem.message}`, status);
        finalized = true;
        if (status !== 'ended') process.exitCode = 1;
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) {
        log('alert', 'consecutive_provider_failures', { count: consecutiveFailures });
      }
      if (consecutiveFailures >= maxConsecutiveFailures) {
        let probe: MeetingProbe;
        try {
          probe = await probeMeetingState('consecutive_event_failures');
        } catch (error) {
          probe = {
            classification: 'inconclusive',
            message: error instanceof Error ? error.message : String(error),
          };
        }
        if (probe.classification === 'ended') {
          meetingEndedAt = probe.endedAt;
          finalize(`meeting probe after ${consecutiveFailures} failures: ${probe.message}`, 'ended');
        } else {
          finalize(`event polling failed ${consecutiveFailures} times; ${probe.message}`, 'action_required');
          process.exitCode = 1;
        }
        finalized = true;
        return;
      }
      const backoffMs = Math.min(60_000, pollMs * 2 ** Math.max(0, consecutiveFailures - 1));
      await Bun.sleep(backoffMs);
      continue;
    }

    const events = extractEvents(result.payload);
    const newRecords: ArchivedEventRecord[] = [];
    for (const event of events) {
      const versionKey = eventVersionKey(event);
      if (seenEventVersions.has(versionKey)) continue;
      seenEventVersions.add(versionKey);
      newRecords.push({
        schemaVersion: 1,
        source: 'polling',
        batch: cursor.committedBatch + 1,
        receivedAt,
        eventVersionKey: versionKey,
        event,
      });
    }
    if (newRecords.length > 0) {
      appendPrivate(eventsPath, newRecords.map(record => JSON.stringify(record)).join('\n') + '\n');
    }

    const pageToken = extractPageToken(result.payload);
    cursor = {
      schemaVersion: 1,
      committedBatch: cursor.committedBatch + 1,
      ...(pageToken ? { pageToken } : cursor.pageToken ? { pageToken: cursor.pageToken } : {}),
      updatedAt: new Date().toISOString(),
      lastSuccessfulPollAt: receivedAt,
    };
    atomicWrite(cursorPath, JSON.stringify(cursor, null, 2) + '\n');
    consecutiveFailures = 0;
    log('info', 'batch_committed', {
      batch: cursor.committedBatch,
      rawFile: rawName,
      providerEvents: events.length,
      archivedEventVersions: newRecords.length,
      pageTokenPresent: !!cursor.pageToken,
    });

    if (polls < maxPolls && Date.now() < deadline) await Bun.sleep(pollMs);
  }

  const reason = polls >= maxPolls ? 'max_polls_reached' : 'deadline_reached';
  let probe: MeetingProbe;
  try {
    probe = await probeMeetingState(reason);
  } catch (error) {
    probe = {
      classification: 'inconclusive',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (probe.classification === 'ended') {
    meetingEndedAt = probe.endedAt;
    finalize(`${reason}; ${probe.message}`, 'ended');
  } else {
    finalize(`${reason} while meeting state is ${probe.classification}: ${probe.message}`, 'action_required');
    process.exitCode = 1;
  }
  finalized = true;
}

try {
  lockOwnership = acquireArchiveLock();
  cursor = loadCursor();
  rawSequence = maxRawSequence();
  seenEventVersions = loadSeenEventVersions();
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (lockOwnership === undefined) {
    if (error instanceof AlreadyRunningError) {
      emitResult({
        ok: true,
        status: 'already_running',
        reason: message,
        requiresNotification: false,
      });
    } else {
      const reason = `lock_failure: ${message}`;
      const recommendedAction = 'Do not start another poller. Inspect the unreadable or stranded lock state; once resolved, rerun poll-and-archive with the same archive directory.';
      const notification = persistPendingNotification('action_required', reason, recommendedAction);
      emitResult({
        ok: false,
        status: 'action_required',
        reason,
        requiresNotification: true,
        recommendedAction,
        notificationPendingPath: notification.path,
        notificationDedupKey: notification.dedupKey,
        notificationPersisted: notification.persisted,
      });
      process.exitCode = 1;
    }
  } else {
    log('alert', 'archive_failure', { message: message.slice(0, 2_000) });
    if (!finalized) {
      try {
        finalize(`archive_failure: ${message}`, 'action_required');
      } catch (finalizeError) {
        log('alert', 'finalize_failure', {
          message: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
        });
      }
    }
  }
  if (!(error instanceof AlreadyRunningError)) process.exitCode = 1;
} finally {
  if (lockOwnership !== undefined) releaseArchiveLock(lockOwnership);
}
