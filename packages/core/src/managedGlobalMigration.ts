import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, basename, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { readGlobalPackageJson, snapshotGlobalPackage, snapshotGlobalTree, type GlobalPackageSnapshotInput } from './managedGlobalSnapshot.js';
import { openGlobalPathGuard } from './managedGlobalGuard.js';
import { createGlobalMutationJournal } from './managedGlobalJournal.js';
import { prepareGlobalObjectPreservation, writeGlobalPrivateEvidence, type GlobalPreservationObject } from './managedGlobalPreservation.js';
import { preflightGlobalProcesses } from './managedGlobalProcesses.js';
import { nativeGlobalProcessTables, type ProcessProbeEvent } from './managedProcessNative.js';
import { readManagedDeploymentAtRoot } from './managedDeploymentRuntime.js';
import { runGlobalNpmUninstall, type GlobalNpmEvent } from './managedGlobalNpm.js';
import { globalNpmLayout, isWindows } from './platform.js';
import { assertSqliteSearchCapability } from './runtimeCapabilities.js';

export type GlobalMigrationInput = { snapshot: GlobalPackageSnapshotInput; binDirectory: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (parent: string, child: string) => { const name = relative(parent, child); return name === '' || name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name); };

/** Production entry: collector injection is confined to the internal fixture binder below. */
export function prepareGlobalMigration(input: GlobalMigrationInput, onEvent: (event: ProcessProbeEvent) => void = () => {}) {
  return bindGlobalMigration(input, onEvent, nativeGlobalProcessTables);
}

/** Never exposed as a CLI collector/guard override. */
export async function bindGlobalMigration(input: GlobalMigrationInput, onEvent: (event: ProcessProbeEvent) => void, collect: typeof nativeGlobalProcessTables) {
  onEvent({ phase: 'global-preflight', event: 'issued' });
  input = structuredClone(input); assertSqliteSearchCapability();
  const globalRoot = resolve(input.snapshot.globalRoot), baseline = snapshotGlobalPackage(input.snapshot), root = dirname(input.snapshot.pointer), active = readManagedDeploymentAtRoot(root);
  assert.equal(active.pointer.release, input.snapshot.expectedRelease, 'global_migration_active_release_changed');
  const layout = globalNpmLayout(globalRoot), binDirectory = realpathSync(input.binDirectory), npmRoot = dirname(dirname(baseline.npm.executable));
  assert.equal(realpathSync(layout.binDirectory), binDirectory, 'global_migration_bin_outside_prefix');
  assert.ok(!inside(globalRoot, root), 'global_migration_backup_inside_global');
  assert.equal(basename(baseline.npm.executable), 'npm-cli.js', 'global_migration_npm_cli_required');
  const legacy = readGlobalPackageJson(join(baseline.packageRoot, 'package.json'));
  assert.ok(!legacy.man && !(legacy.directories && typeof legacy.directories === 'object' && ('bin' in legacy.directories || 'man' in legacy.directories)), 'global_migration_extra_npm_artifacts');
  assert.ok(legacy.bin && typeof legacy.bin === 'object' && Object.keys(legacy.bin).join(',') === 'caveat', 'global_migration_bin_scope');
  const bin = (legacy.bin as Record<string, unknown>).caveat;
  assert.ok(typeof bin === 'string' && !isAbsolute(bin) && inside(realpathSync(baseline.packageRoot), realpathSync(join(baseline.packageRoot, bin))), 'global_migration_bin_redirect');
  const payload = active.packageRoot, manifestFile = join(dirname(payload), 'manifest.json');
  const protectedPaths = [...new Set([...input.snapshot.protectedFiles.map(path => realpathSync(path)), realpathSync(input.snapshot.pointer), manifestFile, payload, join(root, 'entry')])];
  const protectedRoots = protectedPaths.filter(path => !protectedPaths.some(other => other !== path && inside(other, path)));
  const guard = await openGlobalPathGuard([...new Set([globalRoot, binDirectory, root, ...protectedRoots.map(dirname)])]);
  let ownedLock: ReturnType<typeof guard.createJournal> | null = null, lockAtRoot = false, closed = false;
  const close = () => {
    if (closed) return; closed = true;
    try {
      if (ownedLock && lockAtRoot) {
        const result = guard.moveJournalNoReplace(ownedLock, runDirectory!, 'installer-lock.json');
        if (result.status !== 'moved') throw Object.assign(Error('global_migration_lock_archive_unknown'), { lockArchive: result });
        lockAtRoot = false;
      }
    } finally { guard.close(); }
  };
  let runDirectory: string | null = null, planEvidence: ReturnType<typeof writeGlobalPrivateEvidence> | null = null, phase = 'protected-capture';
  try {
    assert.equal(guard.observe(root, 'installer.lock'), null, 'global_migration_installer_busy');
    const protectedObjects = protectedRoots.map(path => {
      const token = guard.retainTree(dirname(path), basename(path)); return { path, token, rows: guard.readTree(token) };
    });
    const payloadObject = protectedObjects.find(row => row.path === payload); assert.ok(payloadObject, 'global_migration_payload_not_captured');
    const payloadFiles = payloadObject.rows.filter(row => row.identity.kind !== 'directory').map(row => {
      assert.equal(row.identity.kind, 'file', 'global_migration_payload_link');
      return { path: row.relativePath, sha256: row.identity.contentSha256, bytes: Number(row.identity.size) };
    }).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(payloadFiles, [...active.manifest.files].sort((a, b) => a.path.localeCompare(b.path)), 'global_migration_payload_changed');
    const leafNames = isWindows() ? ['caveat', 'caveat.cmd', 'caveat.ps1'] : ['caveat'];
    const leaves = leafNames.map(name => ({ name, identity: guard.observe(binDirectory, name) }));
    const scope = { packageRoot: realpathSync(baseline.packageRoot), npmRoot, binAliases: leaves.map(row => join(binDirectory, row.name)) };
    const processCheck = async () => {
      const result = await preflightGlobalProcesses(scope, onEvent, collect);
      if (result.status !== 'ready') throw Object.assign(Error('global_migration_process_preflight_stopped'), { preflight: result }); return result;
    };
    const verifyProtected = () => {
      guard.assertCurrent();
      if (ownedLock && lockAtRoot) guard.readJournal(ownedLock);
      if (planEvidence && runDirectory) assert.equal(createHash('sha256').update(guard.readPersistedJournal(runDirectory, planEvidence.name)).digest('hex'), planEvidence.sha256, 'global_migration_plan_evidence_changed');
      for (const object of protectedObjects) assert.deepEqual(guard.readTree(object.token), object.rows, 'global_migration_protected_changed');
      assert.equal(realpathSync(input.snapshot.node), baseline.node.canonical, 'global_migration_node_alias_changed');
      assert.equal(realpathSync(input.snapshot.npmAlias), baseline.npm.executable, 'global_migration_npm_alias_changed');
      assert.deepEqual(snapshotGlobalTree(baseline.node.canonical, { observeOnly: true, maxBytes: 256 * 1024 * 1024 }), baseline.node.binary, 'global_migration_node_changed');
      assert.deepEqual(snapshotGlobalTree(npmRoot, { observeOnly: true, opaqueExternalLinks: true }), baseline.npm.tree, 'global_migration_npm_changed');
      const others = snapshotGlobalTree(globalRoot, { observeOnly: true, opaqueExternalLinks: true, skip: ['caveat-cli', '.package-lock.json'] }).filter(row => row.relativePath);
      assert.deepEqual(others, baseline.otherGlobals, 'global_migration_other_globals_changed');
      for (const leaf of leaves) if (!leaf.identity) assert.equal(guard.observe(binDirectory, leaf.name), null, 'global_migration_absent_leaf_appeared');
      if (baseline.npmManagement.absent) assert.equal(guard.observe(globalRoot, '.package-lock.json'), null, 'global_migration_absent_management_appeared');
    };
    const verify = async () => { verifyProtected(); await processCheck(); verifyProtected(); };
    phase = 'initial-preflight'; await verify();
    // Repeat the complete initial package view immediately before creating any private run state.
    assert.deepEqual(snapshotGlobalPackage(input.snapshot), baseline, 'global_migration_initial_snapshot_changed');
    for (const leaf of leaves) assert.deepEqual(guard.observe(binDirectory, leaf.name), leaf.identity, 'global_migration_initial_leaf_changed');
    const plan = { schema: 'caveat.global_migration_plan.v1', baseline, leaves, protectedObjects: protectedObjects.map(({ path, rows }) => ({ path, rows })), prefix: layout.prefix };
    const planSha256 = hash(plan), runName = 'global-migration-' + randomBytes(16).toString('hex');
    phase = 'private-run-create'; runDirectory = join(root, runName); guard.createPrivateDirectory(root, runName);
    planEvidence = writeGlobalPrivateEvidence(guard, runDirectory, 'plan.json', plan);
    phase = 'installer-lock-acquire';
    ownedLock = guard.createJournal(runDirectory, 'installer-lock.json', Buffer.from(JSON.stringify({ schema: 1, pid: process.pid, startedAt: new Date().toISOString() }) + '\n'));
    const acquired = guard.moveJournalNoReplace(ownedLock, root, 'installer.lock');
    if (acquired.status !== 'moved') throw Object.assign(Error('global_migration_lock_acquire_unknown'), { lockAcquire: acquired });
    lockAtRoot = true; await verify();
    const journal = createGlobalMutationJournal(guard, runDirectory, 'journal.jsonl', planSha256);
    const objects: GlobalPreservationObject[] = [{ step: 'package', role: 'package', directory: globalRoot, name: 'caveat-cli', backupDirectory: runDirectory, backupName: 'original-package' }];
    if (!baseline.npmManagement.absent) objects.push({ step: 'management', role: 'npm-management', directory: globalRoot, name: '.package-lock.json', backupDirectory: runDirectory, backupName: 'original-management' });
    for (const leaf of leaves) if (leaf.identity) objects.push({ step: leaf.name.replaceAll('.', '-'), role: 'leaf', directory: binDirectory, name: leaf.name, backupDirectory: runDirectory, backupName: 'original-' + leaf.name });
    const engine = prepareGlobalObjectPreservation(guard, journal, objects, verify);
    const userConfig = join(runDirectory, 'user.npmrc'), globalConfig = join(runDirectory, 'global.npmrc');
    const userToken = guard.createJournal(runDirectory, 'user.npmrc', Buffer.from('\n')), globalToken = guard.createJournal(runDirectory, 'global.npmrc', Buffer.from('\n'));
    const preparedRun = runDirectory;
    const uninstall = (observer: (event: GlobalNpmEvent) => void = () => {}) => engine.uninstallWorking(async () => {
      assert.ok(guard.readJournal(userToken).equals(Buffer.from('\n')) && guard.readJournal(globalToken).equals(Buffer.from('\n')), 'global_migration_npm_config_changed');
      return runGlobalNpmUninstall({ node: baseline.node.canonical, script: baseline.npm.executable, prefix: layout.prefix, runDirectory: preparedRun, userConfig, globalConfig }, observer);
    });
    onEvent({ phase: 'global-preflight', event: 'completed' });
    return { status: 'prepared' as const, planSha256, runDirectory, plan, engine, uninstall, journal, verify, verifyProtected, guard,
      close, existingProcessOperations: 0, privilegeElevation: false as const };
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { migrationPhase: phase, runDirectory, filesystemWrites: runDirectory ? null : 0, existingProcessOperations: 0 });
    try { onEvent({ phase: 'global-preflight', event: 'stopped' }); } catch { /* Preserve the failed preflight. */ }
    try { close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'global_migration_prepare_and_close_failed'); }
    throw error;
  }
}
