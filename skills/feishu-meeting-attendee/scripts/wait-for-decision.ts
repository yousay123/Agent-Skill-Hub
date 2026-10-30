#!/usr/bin/env bun

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

function createdAtMs(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return Number.NaN;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function extractMessages(response: unknown): Record<string, unknown>[] {
  const body = asObject(response);
  if (!body || body.ok === false) throw new Error('message listing returned an error envelope');
  const data = asObject(body.data) ?? body;
  const values = Array.isArray(data.messages) ? data.messages : Array.isArray(data.items) ? data.items : [];
  return values.map(asObject).filter((value): value is Record<string, unknown> => Boolean(value));
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: wait-for-decision.ts --chat-id <oc_xxx> --owner-id <ou_xxx> --after <ISO-8601> [--timeout-seconds <0-1800>] [--poll-seconds <2-60>] [--dry-run]\n');
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
const chatId = required(args, '--chat-id');
const ownerId = required(args, '--owner-id');
const after = required(args, '--after');
const timeoutSeconds = Number(optionValue(args, '--timeout-seconds') ?? '300');
const pollSeconds = Number(optionValue(args, '--poll-seconds') ?? '10');
const afterMs = Date.parse(after);

if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error('--chat-id must be a Feishu chat_id');
if (!/^ou_[A-Za-z0-9]+$/.test(ownerId)) throw new Error('--owner-id must be a Feishu open_id');
if (!Number.isFinite(afterMs)) throw new Error('--after must be an ISO 8601 timestamp');
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 1800) throw new Error('--timeout-seconds must be between 0 and 1800');
if (!Number.isFinite(pollSeconds) || pollSeconds < 2 || pollSeconds > 60) throw new Error('--poll-seconds must be between 2 and 60');

const command = [
  'im', '+chat-messages-list', '--as', 'bot', '--chat-id', chatId,
  '--start', after, '--order', 'asc', '--page-size', '50', '--no-reactions', '--json',
];
if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, chatId, ownerId, after, timeoutSeconds, pollSeconds, command: ['lark-cli', ...command] }, null, 2)}\n`);
  process.exit(0);
}

const deadline = Date.now() + timeoutSeconds * 1000;
while (true) {
  const result = spawnSync('lark-cli', command, {
    encoding: 'utf8', env: process.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, outcome: 'read_failed', chatId, error: (result.stderr || result.stdout || `lark-cli exited ${result.status}`).trim() }, null, 2)}\n`);
    process.exit(3);
  }
  let response: unknown;
  try { response = JSON.parse(result.stdout); } catch { throw new Error(`lark-cli returned non-JSON output: ${result.stdout.slice(0, 500)}`); }
  const match = extractMessages(response).find(message => {
    const sender = asObject(message.sender);
    const senderId = sender?.id ?? sender?.open_id ?? sender?.sender_id;
    return senderId === ownerId && createdAtMs(message.create_time) > afterMs && message.deleted !== true;
  });
  if (match) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      received: true,
      chatId,
      ownerId,
      messageId: match.message_id,
      createTime: match.create_time,
      content: match.content,
    }, null, 2)}\n`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    process.stdout.write(`${JSON.stringify({ ok: true, received: false, timedOut: true, chatId, ownerId, after }, null, 2)}\n`);
    process.exit(0);
  }
  await Bun.sleep(Math.min(pollSeconds * 1000, Math.max(0, deadline - Date.now())));
}
