#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

interface Rule {
  name: string;
  pattern: RegExp;
}

const rules: Rule[] = [
  { name: 'Feishu open_id', pattern: new RegExp('\\b' + 'ou_[A-Za-z0-9]{20,}\\b') },
  { name: 'Feishu app_id', pattern: new RegExp('\\b' + 'cli_[A-Za-z0-9]{12,}\\b') },
  { name: 'macOS user home', pattern: new RegExp('/' + 'Users/(?!example(?:/|$)|username(?:/|$)|<)[A-Za-z0-9._-]+/') },
  { name: 'GitHub classic token', pattern: new RegExp('\\bgh' + '[pousr]_[A-Za-z0-9]{20,}\\b') },
  { name: 'GitHub fine-grained token', pattern: new RegExp('\\bgithub_' + 'pat_[A-Za-z0-9_]{20,}\\b') },
  { name: 'private key', pattern: new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----') },
  { name: 'company email', pattern: new RegExp('\\b[A-Za-z0-9._%+-]+@' + 'ksher\\.com\\b', 'i') },
];

const git = Bun.spawnSync(['git', 'ls-files', '-z'], { stdout: 'pipe', stderr: 'pipe' });
if (git.exitCode !== 0) {
  process.stderr.write(new TextDecoder().decode(git.stderr));
  process.exit(git.exitCode || 1);
}

const files = new TextDecoder().decode(git.stdout).split('\0').filter(Boolean);
const failures: Array<{ file: string; rule: string }> = [];
for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes.includes(0)) continue;
  const contents = bytes.toString('utf8');
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(contents)) failures.push({ file, rule: rule.name });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`${failure.file}: blocked secret-shaped content (${failure.rule})`);
  }
  process.exit(1);
}
console.log(`sensitive-content scan passed (${files.length} tracked files)`);
