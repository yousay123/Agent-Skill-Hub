import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function optionValue(args: string[], name: string): string | undefined {
  const eq = args.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function stableUuid(meetingId: string, key: string): string {
  const chars = createHash('sha256')
    .update(`botmux-feishu-meeting-attendee:message:v1:${meetingId}:${key}`)
    .digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = '8';
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: send-message.ts <meeting-id> --key <stable-semantic-key> --text <message> [--dry-run]\n');
  process.exit(0);
}
const meetingId = args.find(arg => !arg.startsWith('--'));
const text = optionValue(args, '--text')?.trim();
const key = optionValue(args, '--key')?.trim();
const dryRun = args.includes('--dry-run');
if (!meetingId || !text || !key) {
  throw new Error('Usage: send-message.ts <meeting-id> --key <stable-semantic-key> --text <message> [--dry-run]');
}
if (text.length > 500) throw new Error('--text must be at most 500 characters');
if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(key)) {
  throw new Error('--key must be 1-100 characters using letters, digits, dot, underscore, or hyphen');
}

const uuid = stableUuid(meetingId, key);
const command = [
  'vc', '+meeting-message-send', '--as', 'bot', '--meeting-id', meetingId,
  '--msg-type', 'text', '--text', text, '--uuid', uuid, '--json',
];
if (dryRun) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, meetingId, key, text, uuid, command: ['lark-cli', ...command] }, null, 2)}\n`);
  process.exit(0);
}

const result = spawnSync('lark-cli', command, {
  encoding: 'utf8', env: process.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    outcome: 'uncertain_or_failed_do_not_retry',
    meetingId,
    key,
    uuid,
    error: (result.stderr || result.stdout || `lark-cli exited ${result.status}`).trim(),
  }, null, 2)}\n`);
  process.exit(3);
}

let response: unknown;
try { response = JSON.parse(result.stdout); } catch { throw new Error(`lark-cli returned non-JSON output: ${result.stdout.slice(0, 500)}`); }
if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('meeting message returned an invalid response');
const body = response as Record<string, unknown>;
if (body.ok === false || (body.code !== undefined && body.code !== 0 && body.code !== '0')) {
  process.stderr.write(`${JSON.stringify({ ok: false, outcome: 'failed_do_not_retry', meetingId, key, uuid, response }, null, 2)}\n`);
  process.exit(3);
}
process.stdout.write(`${JSON.stringify({ ok: true, sent: true, meetingId, key, uuid }, null, 2)}\n`);
