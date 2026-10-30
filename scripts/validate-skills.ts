#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

interface CatalogSkill {
  name: string;
  path: string;
  version: string;
  release_tag: string;
  entrypoint: string;
}

const root = resolve(import.meta.dir, '..');
const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')) as {
  schema_version: number;
  skills: CatalogSkill[];
};
if (catalog.schema_version !== 1 || !Array.isArray(catalog.skills)) {
  throw new Error('catalog.json has an unsupported schema');
}

for (const skill of catalog.skills) {
  const skillDir = join(root, skill.path);
  const entrypoint = join(skillDir, skill.entrypoint);
  if (!existsSync(entrypoint)) throw new Error(`${skill.name}: missing ${skill.entrypoint}`);
  if (basename(skillDir) !== skill.name) throw new Error(`${skill.name}: directory/name mismatch`);
  const markdown = readFileSync(entrypoint, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1];
  if (!frontmatter) throw new Error(`${skill.name}: missing YAML frontmatter`);
  const field = (name: string): string | undefined => {
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(frontmatter);
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  };
  if (field('name') !== skill.name) throw new Error(`${skill.name}: frontmatter name mismatch`);
  if (!field('description')) throw new Error(`${skill.name}: missing description`);
  if (field('version') !== skill.version) throw new Error(`${skill.name}: version mismatch with catalog`);
  if (skill.release_tag !== `${skill.name}-v${skill.version}`) {
    throw new Error(`${skill.name}: release_tag must match name and version`);
  }
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    if (!existsSync(resolve(dirname(entrypoint), target))) {
      throw new Error(`${skill.name}: broken relative link ${target}`);
    }
  }
}
console.log(`skill validation passed (${catalog.skills.length} skill)`);
