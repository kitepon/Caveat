import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registrationFixture } from './registrationFixture.js';

const denySideEffects = `
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('exporter_side_effect'); };
for (const name of ['appendFile','chmod','chown','copyFile','cp','fchmod','fchown','fdatasync','fsync','ftruncate','lchmod','lchown','link','mkdir','mkdtemp','rename','rm','rmdir','symlink','truncate','unlink','utimes','write','writeFile','writev']) {
  for (const key of [name, name + 'Sync']) if (key in fs) fs[key] = deny;
  if (name in fs.promises) fs.promises[name] = deny;
}
fs.createWriteStream = deny;
const openSync = fs.openSync;
const open = fs.open;
const promiseOpen = fs.promises.open;
const check = flags => {
  if (typeof flags === 'number' ? flags !== 0 : /[wa+]/.test(flags)) deny();
};
fs.openSync = (path, flags, ...args) => { check(flags); return openSync(path, flags, ...args); };
fs.open = (path, flags, ...args) => { check(flags); return open(path, flags, ...args); };
fs.promises.open = (path, flags, ...args) => { check(flags); return promiseOpen(path, flags, ...args); };
for (const api of [http, https]) for (const key of ['request','get','createServer']) api[key] = deny;
for (const key of ['connect','createConnection','createServer']) net[key] = deny;
tls.connect = deny;
dgram.createSocket = deny;
for (const key of ['exec','execFile','execFileSync','execSync','fork','spawn','spawnSync']) childProcess[key] = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
`;

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files[entry.name + '/'] = '';
      for (const [name, bytes] of Object.entries(snapshot(path))) files[entry.name + '/' + name] = bytes;
    } else files[entry.name] = readFileSync(path).toString('hex');
  }
  return files;
}

describe('shipped harness-entries CLI', () => {
  it('uses the selected managed launcher without writes, subprocesses, network or private config output', () => {
    const fx = registrationFixture();
    try {
      const preload = join(fx.root, 'deny-side-effects.mjs');
      writeFileSync(preload, denySideEffects);
      writeFileSync(join(fx.home, '.caveatrc.json'), 'invalid config: private-fixture-not-for-output');
      const before = snapshot(fx.home);
      const run = (harnesses: string[]) => spawnSync(process.execPath, [
        // --import takes a module specifier; a bare C:\ path is read as URL scheme "c:" on Windows.
        '--import', pathToFileURL(preload).href, resolve('dist/caveat.js'),
        'harness-entries', '--json', '--home', fx.home,
        ...harnesses.flatMap(name => ['--harness', name]),
      ], {
        cwd: fx.root,
        env: { ...process.env, HOME: fx.home, USERPROFILE: fx.home, CAVEAT_HOME: join(fx.home, 'uncreated') },
        encoding: 'utf8', timeout: 15000,
      });
      const result = run(['codex', 'grok']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      const output = JSON.parse(result.stdout);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(output.schema).toBe('bellteam.harness-entries.v1');
      expect(Object.keys(output.mcpServers.caveat)).toEqual(['codex', 'grok']);
      const mcp = { command: 'node', args: ['--disable-warning=ExperimentalWarning', fx.paths.launcher, 'mcp-server'] };
      expect(output.mcpServers.caveat).toEqual({
        codex: { ...mcp, env_vars: ['CAVEAT_HOME', 'GIT_CONFIG_GLOBAL', 'GH_CONFIG_DIR'] }, grok: mcp,
      });
      expect(Object.keys(output.hooks)).toEqual(['codex']);
      expect(result.stdout).not.toContain('private-fixture-not-for-output');
      expect(result.stdout).not.toContain('fixture-private');
      expect(result.stdout).not.toContain('"KEEP"');
      expect(snapshot(fx.home)).toEqual(before);

      const invalid = run(['gemini']);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe('');
      expect(invalid.stderr).toContain('unsupported harness: gemini');
      expect(snapshot(fx.home)).toEqual(before);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }, 90000);
});
