#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEFAULT_GREETING = '大家好，我是本次会议受托参会的智能体助手，主人现在在忙，我代为参会，会后会同步会议内容和TODO';
type MeetingMode = 'silent' | 'proxy' | 'assistant';

function usage(): never {
  process.stderr.write('Usage: join-and-greet.ts <9-digit-meeting-number-or-link> [--mode silent|proxy|assistant] [--intro <text>] [--dry-run]\n');
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
    const message = error?.message ?? body.message ?? body.msg ?? `${operation} failed`;
    throw new Error(String(message));
  }
  return body;
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('Usage: join-and-greet.ts <9-digit-meeting-number-or-link> [--mode silent|proxy|assistant] [--intro <text>] [--dry-run]\n');
  process.exit(0);
}
const dryRun = argv.includes('--dry-run');
const mode = parseMode(optionValue(argv, '--mode'));
const customIntro = optionValue(argv, '--intro')?.trim();
if (customIntro && customIntro.length > 500) throw new Error('--intro must be at most 500 characters');
const greeting = customIntro || DEFAULT_GREETING;
const optionIndexes = new Set<number>();
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--dry-run' || argv[i].startsWith('--mode=') || argv[i].startsWith('--intro=')) optionIndexes.add(i);
  if (argv[i] === '--mode' || argv[i] === '--intro') { optionIndexes.add(i); optionIndexes.add(i + 1); }
}
const reference = argv.find((_, index) => !optionIndexes.has(index));
if (!reference) usage();

const meetingNo = meetingNumberFrom(reference);
if (!meetingNo) {
  throw new Error('A joinable 9-digit Feishu meeting number or a meeting link containing it is required; an internal meeting.id alone cannot be joined.');
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dryRun: true,
    meetingNo,
    mode,
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

if (mode === 'silent') {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    joined: true,
    greeted: false,
    mode,
    meetingId,
    meetingNo,
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
}, null, 2)}\n`);
