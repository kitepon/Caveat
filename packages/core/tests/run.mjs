import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Native migration requires the executing Node's parents to be private; never change the installed runtime's permissions.
const root = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'caveat-test-node-'));
try {
  const node = root ? join(root, 'bin/node') : process.execPath;
  if (root) {
    mkdirSync(dirname(node), { mode: 0o700 }); copyFileSync(process.execPath, node); chmodSync(node, 0o700);
    const libraries = join(dirname(process.execPath), '../lib');
    if (process.platform === 'darwin' && existsSync(libraries)) {
      mkdirSync(join(root, 'lib'), { mode: 0o700 });
      for (const name of readdirSync(libraries).filter(name => /^libnode(?:\.\d+)*\.dylib$/.test(name))) {
        const file = join(root, 'lib', name); copyFileSync(join(libraries, name), file); chmodSync(file, 0o700);
      }
    }
  }
  const result = spawnSync(node, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { if (root) rmSync(root, { recursive: true, force: true }); }
