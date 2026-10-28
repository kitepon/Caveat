import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolveManagedNode, resolveManagedNodeWithProbe, parseManagedNodeCapability, managedNodePaths } from '../src/managedNode.js';
import { assessGlobalProcesses } from '../src/managedGlobalProcesses.js';
import { runWindowsAclPrivateTree } from '../src/privateWindowsAcl.js';
import { isWindows } from '../src/platform.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-node-proof-'))); roots.push(root);
  mkdirSync(join(root, 'lib'), { mode: 0o700 });
  const library = join(root, 'lib/libnode.137.dylib'); writeFileSync(library, 'isolated library', { mode: 0o600 });
  if (isWindows()) runWindowsAclPrivateTree(root);
  const facts = { schema: 'caveat.node_capability.v1', executable: realpathSync(process.execPath), version: process.version, sqlite: '3.50.0', fts5Trigram: true, shared: true, libraries: [library] };
  return { root, library, facts };
}
describe('ordinary selected Node proof', () => {
  it('probes the actually selected binary and SQLite capability with a closed owned child', { timeout: 30000 }, async () => {
    const events: string[] = [], node = await resolveManagedNode(process.execPath, process.version, event => events.push(event.event));
    try {
      expect(node.proof.capability.fts5Trigram).toBe(true); expect(node.proof.executable.identity.contentSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(node.proof.terminal).toEqual({ spawned: true, exitObserved: true, closeObserved: true, exitCode: 0 });
      const shared = process.config.variables.node_shared === true || process.config.variables.node_shared === 'true';
      expect(node.proof.capability.shared).toBe(shared); expect(node.proof.libraries.length > 0).toBe(shared);
      process.stdout.write('[caveat.managed_node_fixture] ' + JSON.stringify({ node: node.proof.capability.version, shared,
        libraryCount: node.proof.libraries.length, sqlite: node.proof.capability.sqlite, terminal: node.proof.terminal,
        proofSha256: createHash('sha256').update(JSON.stringify(node.proof)).digest('hex') }) + '\n');
      expect(events).toEqual(['issued', 'started', 'completed', 'issued', 'started', 'completed']); node.verify();
    } finally { node.close(); }
  });
  it('refuses relative selection and wrong actual version', { timeout: 30000 }, async () => {
    await expect(resolveManagedNode('node', process.version)).rejects.toThrow('absolute_selection_required');
    await expect(resolveManagedNode(process.execPath, 'v22.0.0')).rejects.toThrow('version_changed');
  });
  it('rejects an unproved shared build and mismatched shared dependency claims', () => {
    const { facts } = fixture();
    expect(() => parseManagedNodeCapability(JSON.stringify({ ...facts, libraries: [] }), facts.executable, process.version)).toThrow('shared_build_unproved');
    expect(() => parseManagedNodeCapability(JSON.stringify({ ...facts, shared: false }), facts.executable, process.version)).toThrow('shared_build_unproved');
  });
  it('selects a different actual Node binary without relying on the current interpreter path', { timeout: 30000 }, async () => {
    const f = fixture(), selected = join(f.root, isWindows() ? 'node.exe' : 'bin/node');
    mkdirSync(dirname(selected), { recursive: true, mode: 0o700 }); copyFileSync(process.execPath, selected); chmodSync(selected, 0o700);
    const current = await resolveManagedNode(process.execPath, process.version);
    try { for (const library of current.proof.libraries) copyFileSync(library.canonical, join(f.root, isWindows() ? basename(library.alias) : 'lib/' + basename(library.alias))); }
    finally { current.close(); }
    if (isWindows()) runWindowsAclPrivateTree(f.root);
    const node = await resolveManagedNode(selected, process.version);
    try { expect(node.proof.executable.canonical).toBe(selected); expect(node.proof.capability.executable).toBe(selected); expect(selected).not.toBe(process.execPath); }
    finally { node.close(); }
  });
  it('binds reported library inode, content, parents and runtime security, then refuses a changed library', { timeout: 30000 }, async () => {
    const f = fixture(); let calls = 0;
    const node = await resolveManagedNodeWithProbe(process.execPath, process.version, () => async () => { calls++; return { stdout: JSON.stringify(f.facts), pid: process.pid + 1 }; });
    try {
      expect(calls).toBe(2); expect(node.proof.libraries[0]!.canonical).toBe(f.library); node.verify();
      if (isWindows()) expect(() => writeFileSync(f.library, 'changed library')).toThrow();
      else { writeFileSync(f.library, 'changed library'); expect(node.verify).toThrowError(expect.objectContaining({ readOnlyCheckFailed: true })); }
    } finally { node.close(); }
  });
  it('refuses a changed dependency during the second probe before returning any proof', { timeout: 30000 }, async () => {
    const f = fixture(); let calls = 0;
    await expect(resolveManagedNodeWithProbe(process.execPath, process.version, () => async () => {
      if (++calls === 2) writeFileSync(f.library, 'concurrent writer');
      return { stdout: JSON.stringify(f.facts), pid: process.pid + 1 };
    })).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it('binds library aliases by identity and includes a library writer in process refusal', { timeout: 30000 }, async () => {
    const f = fixture(), alias = join(f.root, 'lib/libnode.dylib');
    if (isWindows()) copyFileSync(f.library, alias); else symlinkSync(basename(f.library), alias);
    const facts = { ...f.facts, libraries: [alias] };
    const node = await resolveManagedNodeWithProbe(process.execPath, process.version, () => async () => ({ stdout: JSON.stringify(facts), pid: process.pid + 1 }));
    try {
      const image = { path: realpathSync(process.execPath), dev: '1', ino: '2' };
      const self = { pid: process.pid, ppid: process.ppid, birth: 'self', uid: 1, executable: image, argv: [image.path, 'self'] };
      const rows = [self, { ...self, pid: process.pid + 99, birth: 'writer', executable: { path: join(f.root, 'mv'), dev: '1', ino: '3' }, argv: ['mv', alias] }];
      const status = assessGlobalProcesses({ packageRoot: join(f.root, 'pkg'), npmRoot: join(f.root, 'npm'), binAliases: [], protectedPaths: managedNodePaths(node.proof) },
        { before: rows, after: structuredClone(rows), errors: [], selfPid: process.pid, selfExecutable: image, caseInsensitive: isWindows() });
      expect(status.status).toBe('stopped'); expect(status.unknown).toBe(1);
      if (!isWindows()) { renameSync(alias, alias + '.old'); symlinkSync(basename(f.library), alias); expect(node.verify).toThrow('alias_identity_changed'); }
    } finally { node.close(); }
  });
});
