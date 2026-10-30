#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

function usage(exitCode = 0): never {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage: poll-meeting-events.ts <meeting-id> [--poll-ms <milliseconds>] [--start <ISO-time>] [--once] [--dry-run]\n');
  process.exit(exitCode);
}

function optionValue(args: string[], name: string): string | undefined {
  const eq = args.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function runPoll(meetingId: string, start: string | undefined): unknown {
  const command = [
    'vc', '+meeting-events', '--as', 'bot', '--meeting-id', meetingId, '--page-all', '--json',
  ];
  if (start) command.push('--start', start);
  const result = spawnSync('lark-cli', command, {
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
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

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) usage(0);

const optionIndexes = new Set<number>();
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--once' || args[index] === '--dry-run' || args[index].startsWith('--poll-ms=') || args[index].startsWith('--start=')) {
    optionIndexes.add(index);
  }
  if (args[index] === '--poll-ms' || args[index] === '--start') {
    optionIndexes.add(index);
    optionIndexes.add(index + 1);
  }
}

const meetingId = args.find((_, index) => !optionIndexes.has(index))?.trim();
if (!meetingId) usage(2);

const rawPollMs = optionValue(args, '--poll-ms') ?? '5000';
const pollMs = Number(rawPollMs);
if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 300_000) {
  throw new Error('--poll-ms must be an integer between 1000 and 300000');
}

const start = optionValue(args, '--start')?.trim();
if (start && Number.isNaN(Date.parse(start))) throw new Error('--start must be a valid ISO time');
const once = args.includes('--once');
const dryRun = args.includes('--dry-run');
const command = ['lark-cli', 'vc', '+meeting-events', '--as', 'bot', '--meeting-id', meetingId, '--page-all', '--json'];
if (start) command.push('--start', start);

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, meetingId, once, pollMs, command }, null, 2)}\n`);
  process.exit(0);
}

do {
  const payload = runPoll(meetingId, start);
  process.stdout.write(`${JSON.stringify({ collectedAt: new Date().toISOString(), meetingId, payload })}\n`);
  if (!once) await Bun.sleep(pollMs);
} while (!once);
