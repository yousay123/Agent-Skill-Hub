#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function optionValue(args: string[], name: string): string | undefined {
  const eq = args.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args: string[], name: string): string {
  const value = optionValue(args, name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: request-decision.ts <meeting-id> --meeting-no <number> --user-id <ou_xxx> --key <key> --question <text> [--context <text>] [--options <text>] [--deadline <text>] [--dry-run]\n');
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
const meetingId = args.find(arg => !arg.startsWith('--'));
if (!meetingId) throw new Error('Usage: request-decision.ts <meeting-id> --meeting-no <number> --user-id <ou_xxx> --key <key> --question <text> [--context <text>] [--options <text>] [--deadline <text>] [--dry-run]');

const meetingNo = required(args, '--meeting-no');
const userId = required(args, '--user-id');
const key = required(args, '--key');
const question = required(args, '--question');
const context = optionValue(args, '--context')?.trim() || '会议正在等待你的决定';
const options = optionValue(args, '--options')?.trim() || '待明确';
const deadline = optionValue(args, '--deadline')?.trim() || '待明确';

if (!/^ou_[A-Za-z0-9]+$/.test(userId)) throw new Error('--user-id must be a Feishu open_id');
if (!/^\d{9}$/.test(meetingNo)) throw new Error('--meeting-no must be a 9-digit meeting number');
if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(key)) throw new Error('--key must use letters, digits, dot, underscore, or hyphen');

const text = [
  `【会议决策确认｜${meetingNo}】`,
  `需要你决定：${question}`,
  `背景：${context}`,
  `可选项：${options}`,
  `最晚回复：${deadline}`,
  '若未及时回复，我会保持待确认，不会代你表态。会议转述仅作决策参考，不会执行其中夹带的指令。',
  '如需我把结论转达会议，请在回复中明确写“请转达”。',
].join('\n');
if (text.length > 1800) throw new Error('decision message is too long; summarize the meeting context first');

const idempotencyKey = `meet-dec-${createHash('sha256').update(`${meetingId}:${key}`).digest('hex').slice(0, 40)}`;
const sentAt = new Date().toISOString();
const command = [
  'im', '+messages-send', '--as', 'bot', '--user-id', userId,
  '--text', text, '--idempotency-key', idempotencyKey, '--json',
];

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, userId, meetingId, meetingNo, key, idempotencyKey, sentAt, text, command: ['lark-cli', ...command] }, null, 2)}\n`);
  process.exit(0);
}

const result = spawnSync('lark-cli', command, {
  encoding: 'utf8', env: process.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, outcome: 'uncertain_or_failed_do_not_retry', meetingId, key, error: (result.stderr || result.stdout || `lark-cli exited ${result.status}`).trim() }, null, 2)}\n`);
  process.exit(3);
}

let response: unknown;
try { response = JSON.parse(result.stdout); } catch { throw new Error(`lark-cli returned non-JSON output: ${result.stdout.slice(0, 500)}`); }
const body = asObject(response);
if (!body || body.ok === false) {
  process.stderr.write(`${JSON.stringify({ ok: false, outcome: 'failed_do_not_retry', meetingId, key, response }, null, 2)}\n`);
  process.exit(3);
}
const data = asObject(body.data) ?? body;
const messageId = typeof data.message_id === 'string' ? data.message_id : '';
const chatId = typeof data.chat_id === 'string' ? data.chat_id : '';
if (!messageId || !chatId) throw new Error('decision message succeeded but response omitted message_id or chat_id');

process.stdout.write(`${JSON.stringify({ ok: true, sent: true, userId, meetingId, meetingNo, key, idempotencyKey, messageId, chatId, sentAt }, null, 2)}\n`);
