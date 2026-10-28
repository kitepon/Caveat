import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { openGlobalPathGuard, type GlobalGuardIdentity } from './managedGlobalGuard.js';
import { ownedProcessProbe, type ProcessProbeEvent, type ProcessProbeRun } from './managedProcessNative.js';
import { globalNpmEnvironment } from './platform.js';
import { processProtectionTree } from './managedGlobalProcesses.js';
import { snapshotGlobalTree, type GlobalTreeRow } from './managedGlobalSnapshot.js';

type Guard = Awaited<ReturnType<typeof openGlobalPathGuard>>;
type RuntimeFile = { alias: string; canonical: string; identity: GlobalGuardIdentity; aliasRows: GlobalTreeRow[] };
type Facts = { schema: 'caveat.node_capability.v1'; executable: string; version: string; sqlite: string; fts5Trigram: true; shared: boolean; libraries: string[] };
export type ManagedNodeProof = {
  schema: 'caveat.managed_node.v1'; executable: RuntimeFile; libraries: RuntimeFile[];
  directories: ReturnType<Guard['directoryBindings']>; capability: Facts;
  terminal: { spawned: true; exitObserved: true; closeObserved: true; exitCode: 0 };
};
const libraryName = /^(?:libnode(?:\.\d+)*(?:\.dylib|\.so(?:\.\d+)*)|node\.dll)$/i;
const command = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
let sqlite;
try {
  sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
  db.exec("CREATE VIRTUAL TABLE probe USING fts5(value, tokenize='trigram')");
  db.prepare('INSERT INTO probe(value) VALUES (?)').run('Caveat capability probe');
  if (db.prepare('SELECT value FROM probe WHERE probe MATCH ?').get('ability')?.value !== 'Caveat capability probe') throw Error('trigram_result');
} finally { db.close(); }
const shared = process.config.variables.node_shared;
if (![true, false, 'true', 'false'].includes(shared)) throw Error('shared_build_unknown');
const report = process.report.getReport();
if (!Array.isArray(report.sharedObjects)) throw Error('runtime_dependencies_unknown');
const path = require('node:path'), fs = require('node:fs');
const libraries = report.sharedObjects.filter(file => /(?:^|[/\\\\])(?:libnode(?:\\.\\d+)*(?:\\.dylib|\\.so(?:\\.\\d+)*)|node\\.dll)$/i.test(file)).map(file => {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== fs.realpathSync(path.resolve(file))) throw Error('runtime_dependency_alias_unknown');
  return path.resolve(file);
}).sort();
process.stdout.write(JSON.stringify({ schema: 'caveat.node_capability.v1', executable: process.execPath, version: process.version,
  sqlite, fts5Trigram: true, shared: shared === true || shared === 'true',
  libraries }) + '\\n');
`;
const keys = (value: unknown, names: string[]) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'managed_node_object_required');
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'managed_node_fields_invalid');
};
const absolute = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && value.length <= 32768 && !/[\x00-\x1f]/.test(value);
const aliasRows = (alias: string, canonical: string) => alias === canonical ? [] : snapshotGlobalTree(alias, { observeOnly: true, opaqueExternalLinks: true, maxBytes: 256 * 1024 * 1024 });

/** Reported libnode paths must name actual loaded dependencies, not a guessed installation layout. */
export function parseManagedNodeCapability(stdout: string, canonical: string, version: string): Facts {
  assert.ok(Buffer.byteLength(stdout) <= 65536, 'managed_node_output_bound');
  const value = JSON.parse(stdout) as Facts;
  keys(value, ['schema', 'executable', 'version', 'sqlite', 'fts5Trigram', 'shared', 'libraries']);
  assert.ok(value.schema === 'caveat.node_capability.v1' && absolute(value.executable) && realpathSync(value.executable) === canonical, 'managed_node_executable_changed');
  assert.ok(/^v\d+\.\d+\.\d+$/.test(value.version) && Number(value.version.slice(1).split('.')[0]) >= 22 && value.version === version, 'managed_node_version_changed');
  assert.ok(typeof value.sqlite === 'string' && /^\d+\.\d+\.\d+$/.test(value.sqlite) && value.fts5Trigram === true, 'managed_node_capability_unconfirmed');
  assert.ok(typeof value.shared === 'boolean' && Array.isArray(value.libraries) && value.libraries.length <= 4
    && new Set(value.libraries).size === value.libraries.length && value.libraries.every(path => absolute(path) && libraryName.test(basename(path))), 'managed_node_library_scope_invalid');
  assert.equal(value.shared, value.libraries.length > 0, 'managed_node_shared_build_unproved');
  return value;
}

export function managedNodePaths(proof: ManagedNodeProof) {
  assert.ok(proof?.schema === 'caveat.managed_node.v1', 'managed_node_proof_required');
  return [proof.executable, ...proof.libraries].flatMap(row => [row.alias, row.canonical]);
}
/** Identities for process comparison; callers still verify all held runtime proof. */
export function managedNodeProcessObjects(proof: ManagedNodeProof) {
  return [proof.executable, ...proof.libraries].flatMap(row => [
    ...processProtectionTree(row.canonical, [{ relativePath: '', identity: row.identity }]),
    ...processProtectionTree(row.alias, row.aliasRows.map(value => ({ relativePath: value.relativePath, identity: value }))),
  ]);
}
export function managedNodeDirectories(proof: ManagedNodeProof) { return [...new Set(managedNodePaths(proof).map(dirname))]; }

/** Held read-only executable/library handles never grant rename or runtime repair authority. */
export function bindManagedNodeProof(proof: ManagedNodeProof, guard: Guard) {
  keys(proof, ['schema', 'executable', 'libraries', 'directories', 'capability', 'terminal']);
  const paths = managedNodePaths(proof);
  assert.ok(paths.every(absolute) && proof.libraries.length <= 4, 'managed_node_library_scope_invalid');
  parseManagedNodeCapability(JSON.stringify(proof.capability), proof.executable.canonical, proof.capability.version);
  assert.deepEqual(proof.libraries.map(row => row.alias), proof.capability.libraries, 'managed_node_dependency_binding_changed');
  assert.deepEqual(proof.terminal, { spawned: true, exitObserved: true, closeObserved: true, exitCode: 0 }, 'managed_node_terminal_unconfirmed');
  const files = [proof.executable, ...proof.libraries].map(row => {
    keys(row, ['alias', 'canonical', 'identity', 'aliasRows']);
    assert.equal(realpathSync(row.alias), row.canonical, 'managed_node_alias_changed');
    assert.equal(realpathSync(row.canonical), row.canonical, 'managed_node_canonical_changed');
    assert.deepEqual(aliasRows(row.alias, row.canonical), row.aliasRows, 'managed_node_alias_identity_changed');
    const token = guard.retainRuntimeFile(dirname(row.canonical), basename(row.canonical));
    assert.deepEqual(token.identity, row.identity, 'managed_node_file_changed'); return { row, token };
  });
  const verify = () => {
    try {
      guard.assertCurrent(); const directories = guard.directoryBindings();
      assert.ok(Array.isArray(proof.directories) && proof.directories.length > 0 && proof.directories.length <= 512, 'managed_node_parent_binding_required');
      for (const expected of proof.directories) assert.deepEqual(directories.find(row => row.path === expected.path), expected, 'managed_node_parent_changed');
      for (const { row, token } of files) {
        assert.equal(realpathSync(row.alias), row.canonical, 'managed_node_alias_changed');
        assert.deepEqual(aliasRows(row.alias, row.canonical), row.aliasRows, 'managed_node_alias_identity_changed');
        assert.deepEqual(guard.readRuntimeFile(token), row.identity, 'managed_node_file_changed');
      }
    } catch (error) { if (error instanceof Error) Object.assign(error, { readOnlyCheckFailed: true }); throw error; }
  };
  verify(); return verify;
}

export function resolveManagedNode(alias: string, version: string, onEvent: (event: ProcessProbeEvent) => void = () => {}) {
  return resolveManagedNodeWithProbe(alias, version, (canonical, cwd) => ownedProcessProbe(onEvent, { env: globalNpmEnvironment(canonical, cwd), cwd, outputLimit: 65536 }));
}

/** Injection is confined to isolated fixtures; no CLI/environment probe override exists. */
export async function resolveManagedNodeWithProbe(alias: string, version: string,
  makeProbe: (canonical: string, cwd: string) => ProcessProbeRun) {
  assert.ok(absolute(alias), 'managed_node_absolute_selection_required');
  const canonical = realpathSync(alias), cwd = dirname(canonical), initial = await openGlobalPathGuard([...new Set([dirname(alias), cwd])]);
  let guard: Guard | undefined;
  try {
    const token = initial.retainRuntimeFile(cwd, basename(canonical)), identity = token.identity, executableAlias = aliasRows(alias, canonical), run = makeProbe(canonical, cwd);
    const probe = async () => parseManagedNodeCapability((await run(canonical, ['--no-warnings', '--experimental-sqlite', '-e', command], 'node-capability', Date.now() + 20000)).stdout, canonical, version);
    const capability = await probe(); initial.readRuntimeFile(token);
    const libraries = capability.libraries.map(alias => ({ alias, canonical: realpathSync(alias) }));
    guard = await openGlobalPathGuard([...new Set([dirname(alias), cwd, ...libraries.flatMap(row => [dirname(row.alias), dirname(row.canonical)])])]);
    const proof: ManagedNodeProof = { schema: 'caveat.managed_node.v1', executable: { alias, canonical, identity, aliasRows: executableAlias },
      libraries: libraries.map(row => ({ ...row, identity: guard!.retainRuntimeFile(dirname(row.canonical), basename(row.canonical)).identity, aliasRows: aliasRows(row.alias, row.canonical) })),
      directories: guard.directoryBindings(), capability, terminal: { spawned: true, exitObserved: true, closeObserved: true, exitCode: 0 } };
    const verify = bindManagedNodeProof(proof, guard);
    assert.deepEqual(await probe(), capability, 'managed_node_capability_changed'); verify(); initial.readRuntimeFile(token);
    initial.close(); const held = guard;
    return { proof, verify, close: () => held.close() };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const value of [guard, initial]) if (value) try { value.close(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'managed_node_probe_and_close_failed');
    throw error;
  }
}
