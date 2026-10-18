import { copyPrivateEvidenceAssets } from '../../scripts/copy-private-evidence-assets.mjs';
import { defineConfig } from 'tsup';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..');
const coreSchema = join(repoRoot, 'packages', 'core', 'src', 'schema.sql');
const coreMigrations = join(repoRoot, 'packages', 'core', 'src', 'migrations');

/**
 * List of Node.js builtin module names. esbuild strips the `node:` prefix
 * from external builtin imports when bundling. `node:sqlite` in particular
 * is only resolvable via the prefixed form, so we restore the prefix on
 * every builtin specifier in a post-build pass.
 */
const NODE_BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'sqlite', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url',
  'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
];

function restoreNodePrefix(content: string): string {
  for (const name of NODE_BUILTINS) {
    const re = new RegExp(`from\\s+(["'])(${name}(?:/[^"']+)?)\\1`, 'g');
    content = content.replace(re, (_m, q: string, spec: string) => `from ${q}node:${spec}${q}`);
  }
  return content;
}

export default defineConfig({
  entry: ['src/index.ts', 'src/privateEvidence/validation.ts', 'src/privateEvidence/origin.ts', 'src/privateEvidence/candidate.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node22',
  platform: 'node',
  bundle: true,
  noExternal: ['@caveat/core', '@caveat/mcp', '@caveat/web'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __caveat_createRequire } from 'node:module';",
      'const require = __caveat_createRequire(import.meta.url);',
    ].join('\n'),
  },
  onSuccess: async () => {
    const distDir = join(__dirname, 'dist');
    if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

    for (const file of readdirSync(distDir, { recursive: true })) {
      if (!file.endsWith('.js')) continue;
      const outFile = join(distDir, file);
      const patched = restoreNodePrefix(readFileSync(outFile, 'utf-8'));
      writeFileSync(outFile, patched, 'utf-8');
    }

    // Copy the product-owned launcher after clean; it owns minimum-Node SQLite startup.
    const bootstrapPath = join(distDir, 'caveat.js');
    copyFileSync(join(__dirname, 'src', 'bootstrap.mjs'), bootstrapPath);
    chmodSync(bootstrapPath, 0o755);

    copyFileSync(coreSchema, join(distDir, 'schema.sql'));
    const destMigrations = join(distDir, 'migrations');
    if (!existsSync(destMigrations)) mkdirSync(destMigrations, { recursive: true });
    cpSync(coreMigrations, destMigrations, { recursive: true });
    copyPrivateEvidenceAssets();
  },
});
