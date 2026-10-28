import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerMcpServerInstance, staleMcpServersFromTable } from '../src/mcpServerInstances.js';
import { nativeGlobalProcessTables, nativeSelfProcessBirth, type NativeProcessTables } from '../src/managedProcessNative.js';
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'caveat-mcp-version-')); roots.push(home);
  const image = { path: '/usr/bin/node', dev: '1', ino: '2' };
  const rows = [{ pid: 1, ppid: 0, uid: 1000, birth: 'parent', executable: { ...image, path: '/usr/bin/codex' }, argv: ['codex'] },
    { pid: process.pid, ppid: 1, uid: 1000, birth: 'recorded-birth', executable: image, argv: ['node', '/fixed/entry/caveat.mjs', 'mcp-server'] }];
  const tables: NativeProcessTables = { before: rows, after: structuredClone(rows), errors: [], selfPid: 99999, selfExecutable: image, caseInsensitive: false };
  return { home, tables };
}
it('reports a running old loaded version under a fixed entry, shows its parent, and removes only its own receipt on exit', () => {
  const f = fixture(), remove = registerMcpServerInstance(f.home, '0.21.8', 'recorded-birth');
  const result = staleMcpServersFromTable(f.home, '0.21.9', f.tables);
  expect(result.staleServers).toEqual([expect.objectContaining({ pid: process.pid, parentPid: 1, parentApp: 'Codex', version: '0.21.8', versionSource: 'loaded-server-receipt', instruction: expect.stringContaining('Reopen') })]);
  remove(); expect(readdirSync(join(f.home, 'mcp-servers'))).toEqual([]);
});
it('does not attribute an expired receipt to a reused PID or label a current version stale', () => {
  const f = fixture(), remove = registerMcpServerInstance(f.home, '0.21.8', 'old-birth');
  expect(staleMcpServersFromTable(f.home, '0.21.9', f.tables).staleServers).toEqual([]); remove();
  const removeCurrent = registerMcpServerInstance(f.home, '0.21.9', 'recorded-birth');
  expect(staleMcpServersFromTable(f.home, '0.21.9', f.tables).staleServers).toEqual([]); removeCurrent();
});
it('does not report a server that exited between process observations', () => {
  const f = fixture(), remove = registerMcpServerInstance(f.home, '0.21.8', 'recorded-birth');
  f.tables.after = f.tables.after.filter(row => row.pid !== process.pid);
  expect(staleMcpServersFromTable(f.home, '0.21.9', f.tables).staleServers).toEqual([]); remove();
});
it('also identifies an older pre-receipt installation and preserves unreadable processes as a count', () => {
  const f = fixture(), pkg = join(f.home, 'old/node_modules/caveat-cli'); mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '0.21.5' }));
  for (const table of [f.tables.before, f.tables.after]) table[1]!.argv = ['node', join(pkg, 'dist/caveat.js'), 'mcp-server'];
  expect(staleMcpServersFromTable(f.home, '0.21.8', f.tables).staleServers).toEqual([expect.objectContaining({ version: '0.21.5', parentApp: 'Codex', versionSource: 'old-installation' })]);
});
it('matches the running process birth across the lifetime receipt and real process reader', async () => {
  const birth = await nativeSelfProcessBirth(), tables = await nativeGlobalProcessTables();
  const normalize = (value: string) => value.replace(/(\.\d{6})\dZ$/, '$1Z');
  expect(normalize(birth)).toBe(normalize(tables.after.find(row => row.pid === process.pid)!.birth!));
});
