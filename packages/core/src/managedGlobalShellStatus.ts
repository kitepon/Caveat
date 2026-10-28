import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openGlobalPathGuard, type GlobalGuardIdentity } from './managedGlobalGuard.js';
import { managedDeploymentPaths, readManagedDeploymentAtRoot } from './managedDeploymentRuntime.js';
import type { ManagedDeploymentOptions } from './managedDeployment.js';
import { managedShellStatus, renderManagedShellWrappers } from './managedShell.js';
import { readGlobalPackageJson, snapshotGlobalTree, type snapshotGlobalPackage } from './managedGlobalSnapshot.js';
import { legacyHomeFromRoot } from './managedDeploymentLegacy.js';
import { isWindows } from './platform.js';

type NativeManifest = { schema: 'caveat.managed_shell.v2'; node: { command: string; version: string };
  registrationNode: string; launcher: string; entrySha256: string; runtimeSha256: string; binDir: string; windows: boolean; binIdentity: GlobalGuardIdentity; files: { name: string; identity: GlobalGuardIdentity }[] };
type Deployment = { release: string; version: string; launcher: string; payloadVerified: true; pointerSha256: string };
const binding = ({ dev, ino, kind, owner, group, mode, securitySha256 }: GlobalGuardIdentity) => ({ dev, ino, kind, owner, group, mode, securitySha256 });
const fields = (value: unknown, names: string[]) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'native_shell_object_required');
  assert.deepEqual(Object.keys(value).sort(), names.sort(), 'native_shell_fields_invalid');
};

/** v1 remains compatible. v2 independently verifies native objects without a PATH PowerShell child. */
export async function managedShellStatusCurrent(options: ManagedDeploymentOptions = {}) {
  if (options.root && !options.userHome) options = { ...options, userHome: legacyHomeFromRoot(resolve(options.root)) ?? dirname(dirname(resolve(options.root))) };
  const root = managedDeploymentPaths(options.userHome, options.root).root, directory = join(root, 'shell'), path = join(directory, 'manifest.json');
  let deployment: Deployment | null = null, nativeSelected = false;
  try {
    const dir = lstatSync(directory); assert.ok(dir.isDirectory() && !dir.isSymbolicLink(), 'native_shell_directory_redirected');
    const selected = readGlobalPackageJson(path);
    if (selected.schema === 'caveat.managed_shell.v1') return managedShellStatus(options);
    nativeSelected = true;
    assert.equal(selected.schema, 'caveat.managed_shell.v2', 'native_shell_schema_invalid');
    assert.equal(selected.windows, isWindows(), 'native_shell_platform_invalid');
    assert.ok(typeof selected.binDir === 'string' && isAbsolute(selected.binDir) && resolve(selected.binDir) === selected.binDir
      && realpathSync(selected.binDir) === selected.binDir, 'native_shell_bin_invalid');
    const active = readManagedDeploymentAtRoot(root), guard = await openGlobalPathGuard([...new Set([root, directory, selected.binDir, dirname(active.packageRoot)])]);
    try {
      guard.assertPrivateDirectory(directory);
      const bytes = guard.readPersistedJournal(directory, 'manifest.json'); assert.ok(bytes.length <= 65536, 'native_shell_manifest_bound');
      const value: NativeManifest = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      assert.ok(Buffer.from(JSON.stringify(value) + '\n').equals(bytes), 'native_shell_manifest_noncanonical');
      assert.deepEqual(value as unknown, selected, 'native_shell_manifest_changed');
      fields(value, ['schema', 'node', 'registrationNode', 'launcher', 'entrySha256', 'runtimeSha256', 'binDir', 'windows', 'binIdentity', 'files']);
      const pointer = guard.retainTree(root, 'active.json', 'protected'), metadata = guard.retainTree(dirname(active.packageRoot), 'manifest.json', 'protected');
      assert.deepEqual(JSON.parse(guard.readPersistedJournal(root, 'active.json').toString('utf8')), active.pointer, 'native_shell_pointer_changed');
      assert.equal(guard.readTree(metadata)[0]!.identity.contentSha256, active.pointer.manifestSha256, 'native_shell_active_manifest_changed');
      const payload = guard.retainTree(dirname(active.packageRoot), 'package', 'protected'), entry = guard.retainTree(root, 'entry', 'protected');
      const payloadRows = guard.readTree(payload), entryRows = guard.readTree(entry);
      const files = payloadRows.filter(row => row.identity.kind !== 'directory').map(row => {
        assert.equal(row.identity.kind, 'file', 'native_shell_payload_link');
        return { path: row.relativePath, sha256: row.identity.contentSha256, bytes: Number(row.identity.size) };
      }).sort((a, b) => a.path.localeCompare(b.path));
      assert.deepEqual(files, [...active.manifest.files].sort((a, b) => a.path.localeCompare(b.path)), 'native_shell_payload_changed');
      assert.equal(value.launcher, active.launcher, 'native_shell_entry_changed');
      for (const [name, field, source] of [['caveat.mjs', 'entrySha256', 'dist/stable-entry.mjs'], ['managed-deployment.js', 'runtimeSha256', 'dist/managed-deployment.js']] as const) {
        assert.equal(entryRows.find(row => row.relativePath === name)?.identity.contentSha256, value[field], 'native_shell_entry_changed');
        assert.equal(active.manifest.files.find(row => row.path === source)?.sha256, value[field], 'native_shell_entry_changed');
      }
      fields(value.node, ['command', 'version']);
      assert.equal(value.node.command, 'node', 'native_shell_node_invalid');
      assert.equal(value.registrationNode, 'node', 'native_shell_node_invalid');
      let changed: string | null = !isDeepStrictEqual(binding(guard.directoryIdentity(value.binDir)), binding(value.binIdentity)) ? 'bin_identity_changed' : null;
      const generated = renderManagedShellWrappers(value.registrationNode, value.launcher);
      assert.ok(Array.isArray(value.files) && value.files.length === generated.length, 'native_shell_files_invalid');
      const held = [];
      for (const [index, file] of value.files.entries()) {
        fields(file, ['name', 'identity']); const expected = generated[index]!;
        assert.equal(file.name, expected.name, 'native_shell_file_scope_invalid');
        const actual = guard.observe(value.binDir, file.name);
        if (!actual || !isDeepStrictEqual(actual, file.identity) || actual.kind !== 'file' || actual.contentSha256 !== expected.sha256) { changed ??= 'wrapper_identity_or_bytes_changed'; continue; }
        held.push(guard.retainTree(value.binDir, file.name, 'protected'));
      }
      for (const tree of [pointer, metadata, payload, entry, ...held]) guard.readTree(tree);
      assert.ok(guard.readPersistedJournal(directory, 'manifest.json').equals(bytes), 'native_shell_manifest_changed');
      deployment = { release: active.pointer.release, version: active.manifest.version, launcher: active.launcher, payloadVerified: true, pointerSha256: guard.readTree(pointer)[0]!.identity.contentSha256! };
      if (changed) return { native: true as const, status: 'changed' as const, reason: changed, deployment };
      return { native: true as const, status: 'ready' as const, manifest: path, deployment,
        nodeSha256: createHash('sha256').update(JSON.stringify(value.node)).digest('hex'), processAssessment: 'not-performed' as const,
        wrappers: generated.map(file => ({ path: join(value.binDir, file.name), sha256: file.sha256 })) };
    } finally { guard.close(); }
  } catch (error) {
    if (!nativeSelected && (error as NodeJS.ErrnoException).code === 'ENOENT') return managedShellStatus(options);
    return { native: true as const, status: 'unknown' as const, reason: 'native_shell_unconfirmed', deployment: null };
  }
}
