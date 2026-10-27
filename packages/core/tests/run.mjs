import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Native migration requires the executing Node's parents to be private; never change the installed runtime's permissions.
const root = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'caveat-test-node-'));
try {
  const node = root ? join(root, 'node') : process.execPath;
  if (root) { copyFileSync(process.execPath, node); chmodSync(node, 0o700); }
  const result = spawnSync(node, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { if (root) rmSync(root, { recursive: true, force: true }); }
