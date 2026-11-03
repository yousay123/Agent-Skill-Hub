#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_GREETING = '大家好，我是受委托参会的智能体助手，仅做记录与总结，不代表委托人作出承诺；会后我会把会议内容和 TODO 同步给委托人。';
type MeetingMode = 'silent' | 'proxy' | 'assistant';

function usage(): never {
  process.stderr.write('Usage: join-and-greet.ts [<9-digit-meeting-number-or-link>] [--assignment-file FILE] [--mode silent|proxy|assistant] [--intro <text>] [--dry-run]\n');
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
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(assignmentId)) {
    throw new Error(`assignment file has an invalid assignmentId: ${path}`);
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`assignment file has an invalid revision: ${path}`);
  }
  if (!meeting) throw new Error(`assignment file has no meeting reference: ${path}`);
  return { assignmentId, revision, meeting, mode: parseMode(typeof body.mode === 'string' ? body.mode : undefined) };
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
const customIntro = optionValue(argv, '--intro')?.trim();
if (customIntro && customIntro.length > 500) throw new Error('--intro must be at most 500 characters');
const greeting = customIntro || DEFAULT_GREETING;
const optionIndexes = new Set<number>();
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--dry-run' || argv[i].startsWith('--mode=') || argv[i].startsWith('--intro=') || argv[i].startsWith('--assignment-file=')) optionIndexes.add(i);
  if (argv[i] === '--mode' || argv[i] === '--intro' || argv[i] === '--assignment-file') { optionIndexes.add(i); optionIndexes.add(i + 1); }
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

if (mode === 'silent') {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    joined: true,
    greeted: false,
    mode,
    meetingId,
    meetingNo,
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
  process.stderr.write(`${JSON.stringify({
    ok: false,
    joined: true,
    greetingOutcome: 'uncertain_or_failed_do_not_retry',
    mode,
    meetingId,
    meetingNo,
    ...(appliedAssignment ? {
      assignmentId: appliedAssignment.assignmentId,
      assignmentRevision: appliedAssignment.revision,
    } : {}),
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exit(3);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  joined: true,
  greeted: true,
  mode,
  meetingId,
  meetingNo,
  greetingUuid,
  greeting,
  ...(appliedAssignment ? {
    assignmentId: appliedAssignment.assignmentId,
    assignmentRevision: appliedAssignment.revision,
  } : {}),
}, null, 2)}\n`);
