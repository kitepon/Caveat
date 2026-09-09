#!/usr/bin/env node
import { spawnCommandSync } from './process-command.mjs';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);

for (const candidate of candidateCommands()) {
  const result = spawnCommandSync(candidate.command, [...candidate.args, ...args], { stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) {
    console.error(`[caveat] failed to run ${candidate.label}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error('[caveat] pnpm is required but was not found.');
console.error('Install it with `npm install -g pnpm@10.0.0`, or install Node with Corepack enabled.');
process.exit(127);

function* candidateCommands() {
  const explicit = process.env.CAVEAT_PNPM_BIN;
  if (explicit) {
    yield { label: explicit, command: explicit, args: [], shell: true };
  }

  const corepack = findOnPath(process.platform === 'win32' ? ['corepack.cmd', 'corepack.exe', 'corepack'] : ['corepack']);
  if (corepack) {
    yield { label: `${corepack} pnpm`, command: corepack, args: ['pnpm'], shell: true };
  }

  const pnpm = findOnPath(process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']);
  if (pnpm) {
    yield { label: pnpm, command: pnpm, args: [], shell: true };
  }

  const npx = findOnPath(process.platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx']);
  if (npx) {
    yield { label: `${npx} pnpm@10.0.0`, command: npx, args: ['--yes', 'pnpm@10.0.0'], shell: true };
  }
}

function findOnPath(names) {
  for (const name of names) {
    if (isAbsolute(name) && existsSync(name)) return name;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}
