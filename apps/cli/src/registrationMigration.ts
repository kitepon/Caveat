import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { openGlobalPathGuard, createGlobalMutationJournal, parseGlobalMutationJournal, writeGlobalPrivateEvidence,
  snapshotGlobalTree, managedDeploymentPaths, readManagedDeploymentAtRoot, resolveManagedNode, bindManagedNodeProof,
  managedNodeDirectories, managedNodePaths, managedNodeProcessObjects, processProtectionTree, preflightGlobalProcesses,
  type GlobalGuardTree, type GlobalGuardTreeRow, type ManagedNodeProof, type ProcessProbeEvent, type GlobalProcessScope, type GlobalProcessProtection } from '@caveat/core';
import { editRegistrationNodeBytes } from './registrationNodeCodec.js';
import { registrationFileSpecs, type RegistrationSources } from './registrationProjection.js';

type Guard = Awaited<ReturnType<typeof openGlobalPathGuard>>;
type Rows = GlobalGuardTreeRow[];
type Plan = { schema: 'caveat.registration_plan.v1'; home: string; source: RegistrationSources; node: ManagedNodeProof;
  clientsToClose: ReturnType<typeof registrationFileSpecs>['clientsToClose'];
  files: { path: string; original: Rows; beforeSha256: string; afterSha256: string }[];
  protected: { path: string; rows: Rows }[]; directories: ReturnType<Guard['directoryBindings']> };
type Item = { original: { place: 'config' | 'backup'; rows: Rows }; replacement: { place: 'stage' | 'config' | 'quarantine'; run: string; rows: Rows } };
type Model = Item[];
type Seed = { schema: 'caveat.registration_seed.v1'; origin: string; mode: 'migration' | 'recovery'; start: Model; directories: ReturnType<Guard['directoryBindings']>; source: null | { run: string; evidenceSha256: string } };
type Preflight = (scope: GlobalProcessScope, emit: (event: ProcessProbeEvent) => void) => ReturnType<typeof preflightGlobalProcesses>;
export type RegistrationInput = { userHome: string; source: RegistrationSources; nodeVersion: string; clientsClosed?: boolean };
export type RegistrationEvent = { phase: string; event: string; runId: string | null; index?: number; pid?: number };
type Emit = (event: RegistrationEvent) => void;
type Evidence = { run: string; name: string; bytes: number; sha256: string };
type History = { plan: Plan; seed: Seed; model: Model; refs: Evidence[]; roots: string[]; journalSha256: string; verify: () => void };
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const errorHash = (error: unknown) => sha(error instanceof Error ? error.name + ':' + error.message : String(error));
const evidenceHash = (refs: Evidence[]) => hash([...refs].sort((a, b) => a.run.localeCompare(b.run) || a.name.localeCompare(b.name)));
const keyset = (value: unknown, keys: string[]) => { assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'registration_object_required'); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'registration_fields_invalid'); };
const registrationResidualRisks = ['same-file renames include synchronous identity checks and durable journal writes; they are not an atomic exchange',
  'a concurrent config writer or interrupted rename may leave the original in private backup and require manual recovery; unknown objects are never overwritten'] as const;
const runName = (value: string) => /^(?:registration-migration|registration-recovery)-[a-f0-9]{32}$/.test(value);
function assertOrdinaryNode(node: ManagedNodeProof, beforeNode: string) {
  assert.ok(basename(dirname(beforeNode)) === 'bin' && ['node', 'node.exe'].includes(basename(beforeNode)), 'registration_retired_node_scope_unproved');
  const retired = dirname(dirname(beforeNode));
  for (const path of managedNodePaths(node)) {
    const name = relative(retired, path);
    assert.ok(name === '..' || name.startsWith('..' + sep) || isAbsolute(name), 'registration_node_still_uses_retired_runtime');
  }
}
const fileRows = (rows: Rows, expectedSha: string) => {
  assert.ok(Array.isArray(rows) && rows.length === 1 && rows[0]?.relativePath === '' && rows[0].identity?.kind === 'file'
    && rows[0].identity.links === '1' && rows[0].identity.contentSha256 === expectedSha, 'registration_file_rows_invalid');
};
const movedRows = (before: Rows, after: Rows) => {
  const expected = structuredClone(before); assert.ok(typeof after?.[0]?.identity.ctime === 'string', 'registration_move_identity_invalid');
  expected[0]!.identity.ctime = after[0]!.identity.ctime; assert.deepEqual(after, expected, 'registration_original_or_replacement_changed');
};
function validatePlan(plan: Plan, home: string) {
  keyset(plan, ['schema', 'home', 'source', 'node', 'clientsToClose', 'files', 'protected', 'directories']);
  assert.ok(plan.schema === 'caveat.registration_plan.v1' && plan.home === home && resolve(home) === home && realpathSync(home) === home, 'registration_home_changed');
  const specs = registrationFileSpecs(plan.source, home), paths = managedDeploymentPaths(home);
  assert.deepEqual(plan.clientsToClose, specs.clientsToClose, 'registration_client_closure_scope_changed');
  assertOrdinaryNode(plan.node, specs.beforeNode);
  assert.ok(plan.node.executable.alias === specs.proposedNode && Array.isArray(plan.files) && plan.files.length === 7, 'registration_plan_node_or_scope_changed');
  for (const [index, file] of plan.files.entries()) {
    keyset(file, ['path', 'original', 'beforeSha256', 'afterSha256']);
    assert.equal(file.path, specs.files[index]!.path, 'registration_plan_path_unbound');
    assert.equal(file.beforeSha256, specs.files[index]!.observed.sha256, 'registration_plan_before_unbound');
    assert.match(file.afterSha256, /^[a-f0-9]{64}$/); fileRows(file.original, file.beforeSha256);
  }
  assert.ok(Array.isArray(plan.protected) && plan.protected.length === 4, 'registration_protected_scope_changed');
  const payload = plan.protected[2]!.path, release = basename(dirname(payload));
  assert.ok(/^\d+\.\d+\.\d+-[a-f0-9]{20}$/.test(release) && payload === join(paths.releases, release, 'package'), 'registration_payload_scope_invalid');
  assert.deepEqual(plan.protected.map(row => row.path), [paths.pointer, paths.entry, payload, join(dirname(payload), 'manifest.json')], 'registration_protected_scope_changed');
  assert.ok(Array.isArray(plan.directories) && plan.directories.length > 0 && plan.directories.length <= 512, 'registration_directory_bound');
  return specs;
}
function location(plan: Plan, origin: string, index: number, item: Item, replacement: boolean) {
  const paths = managedDeploymentPaths(plan.home), path = plan.files[index]!.path;
  if (!replacement) return item.original.place === 'config' ? { directory: dirname(path), name: basename(path) }
    : { directory: join(paths.root, origin), name: 'original-' + index };
  return item.replacement.place === 'config' ? { directory: dirname(path), name: basename(path) }
    : { directory: join(paths.root, item.replacement.run), name: (item.replacement.place === 'stage' ? 'new-' : 'used-') + index };
}
function modelKeys(model: Model, plan: Plan, origin: string, roots: string[]) {
  assert.ok(Array.isArray(model) && model.length === 7 && runName(origin), 'registration_state_scope_invalid');
  for (const [index, item] of model.entries()) {
    keyset(item, ['original', 'replacement']); keyset(item.original, ['place', 'rows']); keyset(item.replacement, ['place', 'run', 'rows']);
    assert.ok(['config', 'backup'].includes(item.original.place) && ['stage', 'config', 'quarantine'].includes(item.replacement.place), 'registration_state_place_invalid');
    assert.ok(roots.includes(item.replacement.run) && (item.replacement.place === 'quarantine' || item.replacement.run === origin), 'registration_state_run_unbound');
    fileRows(item.original.rows, plan.files[index]!.beforeSha256); movedRows(plan.files[index]!.original, item.original.rows);
    fileRows(item.replacement.rows, plan.files[index]!.afterSha256);
    assert.ok(item.original.place !== 'config' || item.replacement.place !== 'config', 'registration_state_name_conflict');
  }
}
function bindProtected(plan: Plan, guard: Guard) {
  const runtime = bindManagedNodeProof(plan.node, guard);
  const trees = plan.protected.map(row => ({ ...row, token: guard.retainTree(dirname(row.path), basename(row.path)) }));
  const verify = () => {
    guard.assertCurrent(); runtime(); const directories = guard.directoryBindings();
    for (const row of plan.directories) assert.deepEqual(directories.find(value => value.path === row.path), row, 'registration_parent_changed');
    for (const row of trees) assert.deepEqual(guard.readTree(row.token), row.rows, 'registration_protected_changed');
  };
  verify(); return verify;
}
function scope(plan: Plan, roots: string[]): GlobalProcessScope {
  return { binAliases: [], runtimeExecutables: [plan.node.executable.canonical], protectedPaths: [...new Set([
    ...plan.files.map(row => row.path), ...plan.protected.map(row => row.path), ...roots,
  ])] };
}
async function freshProcesses(plan: Plan, roots: string[], preflight: Preflight, emit: Emit, protection: () => GlobalProcessProtection) {
  const result = await preflight({ ...scope(plan, roots), retainedRoots: roots, protection }, event => emit({ phase: event.phase, event: event.event, pid: event.pid, runId: null }));
  if (result.status !== 'ready') throw Object.assign(Error('registration_process_preflight_stopped'), { preflight: result, readOnlyCheckFailed: !('protectionFailure' in result && result.protectionFailure && !result.protectionFailure.readOnly) });
  return result;
}
function registrationProcessProtection(plan: Plan, verify: () => void, model?: Model, origin?: string): () => GlobalProcessProtection {
  return () => {
    verify();
    const objects = [...managedNodeProcessObjects(plan.node), ...plan.protected.flatMap(row => processProtectionTree(row.path, row.rows))], absent: string[] = [];
    for (const [index, file] of plan.files.entries()) {
      const item = model?.[index];
      if (!item) objects.push(...processProtectionTree(file.path, file.original));
      else {
        for (const replacement of [false, true]) {
          const place = location(plan, origin!, index, item, replacement);
          objects.push(...processProtectionTree(join(place.directory, place.name), replacement ? item.replacement.rows : item.original.rows, file.path));
        }
        if (item.original.place !== 'config' && item.replacement.place !== 'config') absent.push(file.path);
      }
    }
    return { objects, absent, postMutation: !!model, mutationPaths: objects.filter(row => plan.files.some(file => row.originalPath === file.path)).map(row => row.path) };
  };
}

function bindCurrent(plan: Plan, seed: Seed, model: Model, roots: string[], guard: Guard) {
  const specs = validatePlan(plan, plan.home); modelKeys(model, plan, seed.origin, roots);
  const protectedVerify = bindProtected(plan, guard);
  const held = model.map((item, index) => {
    const original = location(plan, seed.origin, index, item, false), replacement = location(plan, seed.origin, index, item, true);
    const originalToken = guard.retainTree(original.directory, original.name), replacementToken = guard.retainTree(replacement.directory, replacement.name);
    assert.deepEqual(guard.readTree(originalToken), item.original.rows, 'registration_original_changed');
    assert.deepEqual(guard.readTree(replacementToken), item.replacement.rows, 'registration_replacement_changed');
    const beforeBytes = guard.readRetainedFile(originalToken), edited = editRegistrationNodeBytes(beforeBytes, specs.files[index]!.format, specs.files[index]!.targets, specs.beforeNode, specs.proposedNode);
    assert.equal(edited.beforeSha256, plan.files[index]!.beforeSha256); assert.equal(edited.afterSha256, plan.files[index]!.afterSha256, 'registration_edited_bytes_unbound');
    assert.ok(guard.readRetainedFile(replacementToken).equals(edited.bytes), 'registration_other_bytes_changed');
    return { original: originalToken, replacement: replacementToken };
  });
  const verify = () => {
    protectedVerify();
    for (const [index, item] of model.entries()) {
      assert.deepEqual(guard.readTree(held[index]!.original), item.original.rows, 'registration_original_changed');
      assert.deepEqual(guard.readTree(held[index]!.replacement), item.replacement.rows, 'registration_replacement_changed');
      const path = plan.files[index]!.path;
      if (item.original.place === 'backup' && item.replacement.place !== 'config') assert.equal(guard.observe(dirname(path), basename(path)), null, 'registration_unknown_config_appeared');
      if (item.original.place === 'config') assert.equal(guard.observe(join(managedDeploymentPaths(plan.home).root, seed.origin), 'original-' + index), null, 'registration_unknown_backup_appeared');
      const root = managedDeploymentPaths(plan.home).root;
      if (item.replacement.place !== 'stage') assert.equal(guard.observe(join(root, seed.origin), 'new-' + index), null, 'registration_unknown_stage_appeared');
      for (const run of roots.filter(run => run !== seed.origin)) {
        if (!(item.replacement.place === 'quarantine' && item.replacement.run === run)) assert.equal(guard.observe(join(root, run), 'used-' + index), null, 'registration_unknown_quarantine_appeared');
      }
    }
  };
  verify(); return { held, verify };
}

/** Read-only admission. Source paths must equal the seven normal paths derived above. */
export async function bindRegistrationAdmission(input: RegistrationInput, emit: Emit = () => {}, preflight: Preflight = preflightGlobalProcesses) {
  input = structuredClone(input); const home = resolve(input.userHome);
  assert.ok(isAbsolute(input.userHome) && realpathSync(home) === home, 'registration_canonical_home_required');
  const collectProcesses = preflight;
  let processAssessment: Awaited<ReturnType<Preflight>> | null = null;
  preflight = async (...args) => { processAssessment = await collectProcesses(...args); return processAssessment; };
  const specs = registrationFileSpecs(input.source, home), paths = managedDeploymentPaths(home), active = readManagedDeploymentAtRoot(paths.root);
  const runtime = await resolveManagedNode(specs.proposedNode, input.nodeVersion, event => emit({ ...event, runId: null }));
  let guard: Guard;
  try { guard = await openGlobalPathGuard([...new Set([paths.root, dirname(active.packageRoot), ...specs.files.map(row => dirname(row.path)), ...managedNodeDirectories(runtime.proof)])]); }
  catch (error) { runtime.close(); throw error; }
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { guard.close(); } finally { runtime.close(); } };
  try {
    assertOrdinaryNode(runtime.proof, specs.beforeNode);
    assert.equal(guard.observe(paths.root, 'installer.lock'), null, 'registration_installer_busy');
    const protectedPaths = [paths.pointer, paths.entry, active.packageRoot, join(dirname(active.packageRoot), 'manifest.json')];
    const protectedObjects = protectedPaths.map(path => ({ path, token: guard.retainTree(dirname(path), basename(path)) }));
    const protectedRows = protectedObjects.map(row => ({ path: row.path, rows: guard.readTree(row.token) }));
    const payload = protectedRows[2]!.rows.filter(row => row.identity.kind !== 'directory').map(row => {
      assert.equal(row.identity.kind, 'file', 'registration_payload_link'); return { path: row.relativePath, sha256: row.identity.contentSha256, bytes: Number(row.identity.size) };
    }).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(payload, [...active.manifest.files].sort((a, b) => a.path.localeCompare(b.path)), 'registration_payload_changed');
    assert.equal(protectedRows[3]!.rows[0]!.identity.contentSha256, active.pointer.manifestSha256, 'registration_manifest_changed');
    assert.deepEqual(JSON.parse(guard.readRetainedFile(protectedObjects[0]!.token).toString('utf8')), active.pointer, 'registration_pointer_changed');
    for (const [name, source] of [['caveat.mjs', 'dist/stable-entry.mjs'], ['managed-deployment.js', 'dist/managed-deployment.js']]) {
      assert.equal(protectedRows[1]!.rows.find(row => row.relativePath === name)?.identity.contentSha256, payload.find(row => row.path === source)?.sha256, 'registration_entry_changed');
    }
    const originals = specs.files.map(spec => {
      assert.equal(realpathSync(dirname(spec.path)), dirname(spec.path), 'registration_config_parent_redirected');
      const token = guard.retainTree(dirname(spec.path), basename(spec.path)), rows = guard.readTree(token); fileRows(rows, spec.observed.sha256);
      const portable = snapshotGlobalTree(spec.path, { observeOnly: true })[0]!;
      assert.deepEqual([portable.dev, portable.ino, portable.uid, portable.gid, portable.mode, Number(portable.size), portable.sha256],
        [spec.observed.dev, spec.observed.ino, spec.observed.uid, spec.observed.gid, Number(spec.observed.mode), spec.observed.bytes, spec.observed.sha256], 'registration_saved_original_changed');
      const bytes = guard.readRetainedFile(token), edited = editRegistrationNodeBytes(bytes, spec.format, spec.targets, specs.beforeNode, specs.proposedNode);
      assert.deepEqual(guard.readTree(token), rows, 'registration_original_changed');
      assert.equal(guard.directoryIdentity(dirname(spec.path)).dev, guard.directoryIdentity(paths.root).dev, 'registration_cross_volume');
      return { token, rows, edited };
    });
    const plan: Plan = { schema: 'caveat.registration_plan.v1', home, source: input.source, node: runtime.proof, clientsToClose: specs.clientsToClose,
      files: originals.map((row, index) => ({ path: specs.files[index]!.path, original: row.rows, beforeSha256: row.edited.beforeSha256, afterSha256: row.edited.afterSha256 })),
      protected: protectedRows, directories: guard.directoryBindings() };
    const verify = () => {
      guard.assertCurrent(); runtime.verify();
      for (const row of protectedObjects) assert.deepEqual(guard.readTree(row.token), protectedRows.find(value => value.path === row.path)!.rows, 'registration_protected_changed');
      for (const row of originals) guard.readTree(row.token);
    };
    await freshProcesses(plan, [], preflight, emit, registrationProcessProtection(plan, verify));
    assert.equal(guard.observe(paths.root, 'installer.lock'), null, 'registration_installer_busy');
    return { plan, planSha256: hash(plan), guard, originals, verify, close, preflight, clientsClosed: input.clientsClosed === true, processAssessment: () => processAssessment };
  } catch (error) { close(); throw error; }
}

function replay(plan: Plan, seed: Seed, run: string, journal: ReturnType<typeof parseGlobalMutationJournal>, read: (name: string) => Buffer) {
  const model = structuredClone(seed.start); let pending: { index: number; action: string; operation: string } | null = null;
  let migrationIndex = 0;
  for (const row of journal.records) {
    if (row.kind === 'complete') { assert.equal(row.stateSha256, hash(model), 'registration_checkpoint_changed'); continue; }
    const match = /^(retain|publish|quarantine|restore)\.([0-6])$/.exec(row.step); assert.ok(match, 'registration_unknown_source_step');
    const action = match[1]!, index = Number(match[2]), item = model[index]!;
    if (row.kind === 'intent') {
      assert.equal(row.stateSha256, hash(model), 'registration_source_intent_unbound');
      if (seed.mode === 'migration') {
        assert.equal(index, migrationIndex, 'registration_source_order_invalid');
        assert.equal(action, item.original.place === 'config' ? 'retain' : 'publish', 'registration_source_order_invalid');
      } else assert.ok(action === 'quarantine' && item.replacement.place === 'config' || action === 'restore' && item.original.place === 'backup' && item.replacement.place !== 'config', 'registration_recovery_order_invalid');
      assert.equal(row.operation, action === 'retain' ? 'retain' : action === 'publish' ? 'manifest' : action === 'quarantine' ? 'working-copy' : 'restore', 'registration_source_operation_invalid');
      pending = { index, action, operation: row.operation }; continue;
    }
    assert.ok(pending && pending.index === index && pending.action === action && row.outcome === 'confirmed', 'registration_source_unconfirmed');
    const bytes = read('state-' + row.sequence + '.json'); assert.equal(sha(bytes), row.stateSha256, 'registration_source_state_hash_changed');
    const state = decodeEvidence(bytes) as { schema: string; state: Model; move: any };
    keyset(state, ['schema', 'state', 'move']); assert.equal(state.schema, 'caveat.registration_move.v1', 'registration_source_state_invalid');
    keyset(state.move, ['status', 'renameIssued', 'before', 'after', 'automaticRecovery', 'treeBefore', 'treeAfter']);
    const replacement: boolean = action === 'publish' || action === 'quarantine', before: Rows = replacement ? item.replacement.rows : item.original.rows;
    const after = state.move?.treeAfter as Rows;
    assert.ok(state.move?.status === 'moved' && state.move.renameIssued === true && state.move.automaticRecovery === false, 'registration_source_move_unproved');
    assert.deepEqual(state.move.treeBefore, before, 'registration_source_before_changed');
    assert.deepEqual(state.move.before, before[0]!.identity, 'registration_source_before_changed');
    movedRows(before, after); assert.deepEqual(state.move.after, after[0]!.identity, 'registration_source_after_changed');
    if (action === 'retain') { assert.equal(item.replacement.place, 'stage'); item.original = { place: 'backup', rows: after }; }
    else if (action === 'publish') { assert.equal(item.original.place, 'backup'); assert.equal(item.replacement.place, 'stage'); item.replacement = { place: 'config', run: seed.origin, rows: after }; migrationIndex++; }
    else if (action === 'quarantine') { item.replacement = { place: 'quarantine', run, rows: after }; }
    else item.original = { place: 'config', rows: after };
    assert.deepEqual(state.state, model, 'registration_source_state_unbound'); pending = null;
  }
  assert.ok(!pending, 'registration_source_pending');
  if (journal.status === 'complete') assert.ok(seed.mode === 'migration' ? migrationIndex === 7 : model.every(item => item.original.place === 'config' && item.replacement.place !== 'config'), 'registration_incomplete_checkpoint');
  return model;
}
function decodeEvidence(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024, 'registration_evidence_bound');
  const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  assert.ok(Buffer.from(JSON.stringify(value) + '\n').equals(bytes), 'registration_noncanonical_evidence'); return value;
}
async function withHistory<T>(home: string, run: string, planSha256: string, use: (history: History) => Promise<T>, seen = new Set<string>(), budget = { files: 0, bytes: 0 }, journals = new Set<string>()): Promise<T> {
  assert.ok(runName(run) && !seen.has(run) && seen.size < 8, 'registration_source_cycle_or_bound'); seen.add(run);
  const directory = join(managedDeploymentPaths(home).root, run); assert.equal(realpathSync(directory), directory, 'registration_source_alias_forbidden');
  const evidence = await openGlobalPathGuard([directory]);
  try {
    evidence.assertPrivateDirectory(directory); const cache = new Map<string, Buffer>();
    const read = (name: string) => {
      if (cache.has(name)) return cache.get(name)!;
      const bytes = evidence.readPersistedJournal(directory, name); budget.files++; budget.bytes += bytes.length;
      assert.ok(budget.files <= 256 && budget.bytes <= 64 * 1024 * 1024, 'registration_source_evidence_bound'); cache.set(name, bytes); return bytes;
    };
    const plan = decodeEvidence(read('plan.json')) as Plan; assert.equal(hash(plan), planSha256, 'registration_source_plan_changed'); validatePlan(plan, home);
    const seed = decodeEvidence(read('seed.json')) as Seed; keyset(seed, ['schema', 'origin', 'mode', 'start', 'directories', 'source']);
    assert.ok(seed.schema === 'caveat.registration_seed.v1' && ['migration', 'recovery'].includes(seed.mode), 'registration_source_seed_invalid');
    assert.ok(Array.isArray(seed.directories) && seed.directories.length > 0 && seed.directories.length <= 512, 'registration_source_directory_bound');
    for (const current of evidence.directoryBindings()) assert.deepEqual(seed.directories.find(row => row.path === current.path), current, 'registration_source_directory_changed');
    const journal = parseGlobalMutationJournal(read('journal.jsonl'), planSha256);
    assert.ok(!journals.has(journal.header.runId), 'registration_reused_source_journal'); journals.add(journal.header.runId);
    assert.ok(['ready', 'complete'].includes(journal.status) && journal.records.length <= 32 && journal.records.every(row => row.kind !== 'result' || row.outcome === 'confirmed'), 'registration_source_pending_torn_or_unknown');
    const finish = async (parent?: History) => {
      if (parent) {
        assert.deepEqual(plan, parent.plan, 'registration_source_origin_changed');
        assert.ok(seed.source && seed.source.run === parent.roots.at(-1) && seed.source.evidenceSha256 === evidenceHash(parent.refs), 'registration_source_digest_unbound');
        assert.equal(seed.origin, parent.seed.origin, 'registration_source_origin_changed'); assert.deepEqual(seed.start, parent.model, 'registration_source_seed_unbound');
      } else {
        assert.ok(seed.mode === 'migration' && seed.origin === run && seed.source === null && run.startsWith('registration-migration-'), 'registration_source_origin_invalid');
        modelKeys(seed.start, plan, run, [run]);
        for (const [index, item] of seed.start.entries()) {
          assert.deepEqual(item.original, { place: 'config', rows: plan.files[index]!.original }, 'registration_original_seed_unbound');
          assert.equal(item.replacement.place, 'stage', 'registration_replacement_seed_unbound');
        }
      }
      const roots = [...(parent?.roots ?? []), run], model = replay(plan, seed, run, journal, read); modelKeys(model, plan, seed.origin, roots);
      const refs = [...(parent?.refs ?? []), ...[...cache].map(([name, bytes]) => ({ run, name, bytes: bytes.length, sha256: sha(bytes) }))];
      const verify = () => {
        parent?.verify(); evidence.assertCurrent(); assert.equal(realpathSync(directory), directory, 'registration_source_alias_forbidden');
        for (const [name, bytes] of cache) assert.ok(evidence.readPersistedJournal(directory, name).equals(bytes), 'registration_source_evidence_changed');
      };
      verify(); return use({ plan, seed, model, refs, roots, journalSha256: journal.bytesSha256, verify });
    };
    if (seed.mode === 'recovery') {
      assert.ok(run.startsWith('registration-recovery-') && seed.source && runName(seed.source.run), 'registration_recovery_source_invalid');
      return await withHistory(home, seed.source.run, planSha256, finish, seen, budget, journals);
    }
    return await finish();
  } finally { evidence.close(); }
}
async function withCurrent<T>(home: string, run: string, planSha256: string, use: (history: History, binding: ReturnType<typeof bindCurrent>, guard: Guard) => Promise<T>) {
  assert.ok(isAbsolute(home) && realpathSync(home) === home && resolve(home) === home, 'registration_canonical_home_required');
  assert.match(planSha256, /^[a-f0-9]{64}$/);
  return withHistory(home, run, planSha256, async history => {
    const { plan, model, seed, roots } = history, paths = managedDeploymentPaths(home);
    const guard = await openGlobalPathGuard([...new Set([paths.root, ...roots.map(run => join(paths.root, run)),
      ...plan.files.map(row => dirname(row.path)), ...plan.protected.map(row => dirname(row.path)), ...managedNodeDirectories(plan.node)])]);
    try {
      for (const root of roots) guard.assertPrivateDirectory(join(paths.root, root));
      const current = bindCurrent(plan, seed, model, roots, guard); history.verify();
      return await use(history, current, guard);
    } finally { guard.close(); }
  });
}

/** Journal inspection and current-object checking never authorize replay of an old attempt. */
export async function planRegistrationRecovery(home: string, run: string, planSha256: string, emit: Emit = () => {}, preflight: Preflight = preflightGlobalProcesses) {
  return withCurrent(home, run, planSha256, async (history, current, guard) => {
    const paths = managedDeploymentPaths(home);
    assert.equal(guard.observe(paths.root, 'installer.lock'), null, 'registration_installer_busy');
    const processAssessment = await freshProcesses(history.plan, history.roots.map(run => join(paths.root, run)), preflight, emit, registrationProcessProtection(history.plan, () => { current.verify(); history.verify(); }, history.model, history.seed.origin));
    assert.equal(guard.observe(paths.root, 'installer.lock'), null, 'registration_installer_busy');
    const evidenceSha256 = hash({ source: evidenceHash(history.refs), state: history.model, directories: guard.directoryBindings() });
    return { status: history.model.some(item => item.original.place === 'backup') ? 'ready' as const : 'already-original' as const,
      planSha256, evidenceSha256, processAssessment, clientsToClose: history.plan.clientsToClose, otherConfigWritersMustBeClosed: true, residualRisks: registrationResidualRisks, currentObjects: 'confirmed' as const, filesystemWrites: 0, executionPermission: false as const };
  });
}

function openAttempt(guard: Guard, plan: Plan, run: string) {
  const paths = managedDeploymentPaths(plan.home); assert.equal(guard.observe(paths.root, 'installer.lock'), null, 'registration_installer_busy');
  const directory = guard.createPrivateDirectory(paths.root, run);
  writeGlobalPrivateEvidence(guard, directory, 'plan.json', plan);
  const lock = guard.createJournal(directory, 'installer-lock.json', Buffer.from(JSON.stringify({ schema: 1, pid: process.pid, startedAt: new Date().toISOString() }) + '\n'));
  const result = guard.moveJournalNoReplace(lock, paths.root, 'installer.lock');
  assert.equal(result.status, 'moved', 'registration_lock_acquire_unknown');
  let active = true;
  const verifyLock = () => { if (active) guard.readJournal(lock); };
  const closeLock = () => {
    if (!active) return;
    assert.equal(guard.moveJournalNoReplace(lock, directory, 'installer-lock.json').status, 'moved', 'registration_lock_archive_unknown'); active = false;
  };
  return { directory, verifyLock, closeLock };
}
function verifyModel(guard: Guard, plan: Plan, seed: Seed, model: Model, held: { original: GlobalGuardTree; replacement: GlobalGuardTree }[], actor: string) {
  guard.assertCurrent(); const root = managedDeploymentPaths(plan.home).root;
  for (const [index, item] of model.entries()) {
    assert.deepEqual(guard.readTree(held[index]!.original), item.original.rows, 'registration_original_changed');
    assert.deepEqual(guard.readTree(held[index]!.replacement), item.replacement.rows, 'registration_replacement_changed');
    const path = plan.files[index]!.path;
    if (item.original.place === 'backup' && item.replacement.place !== 'config') assert.equal(guard.observe(dirname(path), basename(path)), null, 'registration_unknown_config_appeared');
    if (item.original.place === 'config') assert.equal(guard.observe(join(root, seed.origin), 'original-' + index), null, 'registration_unknown_backup_appeared');
    if (item.replacement.place !== 'stage') assert.equal(guard.observe(join(root, seed.origin), 'new-' + index), null, 'registration_unknown_stage_appeared');
    if (actor.startsWith('registration-recovery-') && !(item.replacement.place === 'quarantine' && item.replacement.run === actor)) assert.equal(guard.observe(join(root, actor), 'used-' + index), null, 'registration_unknown_quarantine_appeared');
  }
}
function performMove(guard: Guard, journal: ReturnType<typeof createGlobalMutationJournal>, plan: Plan, seed: Seed, model: Model,
  held: { original: GlobalGuardTree; replacement: GlobalGuardTree }[], run: string, action: 'retain' | 'publish' | 'quarantine' | 'restore', index: number,
  verify: () => void, emit: Emit) {
  verify(); const step = action + '.' + index, operation = action === 'retain' ? 'retain' : action === 'publish' ? 'manifest' : action === 'quarantine' ? 'working-copy' : 'restore';
  journal.intent(step, operation, hash(model)); emit({ phase: step, event: 'intent-durable', runId: run, index });
  verify(); const root = managedDeploymentPaths(plan.home).root, file = plan.files[index]!.path, item = model[index]!;
  const replacement = action === 'publish' || action === 'quarantine', token = replacement ? held[index]!.replacement : held[index]!.original;
  const destination = action === 'retain' ? { directory: join(root, seed.origin), name: 'original-' + index }
    : action === 'quarantine' ? { directory: join(root, run), name: 'used-' + index } : { directory: dirname(file), name: basename(file) };
  const move = guard.moveTreeNoReplace(token, destination.directory, destination.name);
  let failure: unknown;
  if (move.status === 'moved') {
    const rows = guard.readTree(token);
    if (action === 'retain') item.original = { place: 'backup', rows };
    else if (action === 'restore') item.original = { place: 'config', rows };
    else item.replacement = { place: action === 'publish' ? 'config' : 'quarantine', run: action === 'publish' ? seed.origin : run, rows };
    try { verify(); } catch (error) { failure = error; }
  }
  const ref = writeGlobalPrivateEvidence(guard, join(root, run), 'state-' + journal.read().nextSequence + '.json', { schema: 'caveat.registration_move.v1', state: model, move });
  const confirmed = move.status === 'moved' && (!failure || !!(failure as { readOnlyCheckFailed?: boolean }).readOnlyCheckFailed);
  journal.result(step, operation, confirmed ? 'confirmed' : 'unknown', ref.sha256);
  emit({ phase: step, event: confirmed ? 'completed' : 'unknown', runId: run, index });
  assert.ok(confirmed, 'registration_move_or_verification_unknown');
  if (failure) throw failure;
}
async function independentReadback(plan: Plan, run: string, planSha256: string, journalSha256: string, expected: Model, directories: ReturnType<Guard['directoryBindings']>) {
  return withCurrent(plan.home, run, planSha256, async (history, current, guard) => {
    assert.equal(history.journalSha256, journalSha256, 'registration_readback_journal_changed');
    assert.deepEqual(history.model, expected, 'registration_readback_state_changed');
    const actual = guard.directoryBindings();
    for (const row of directories) assert.deepEqual(actual.find(value => value.path === row.path), row, 'registration_readback_directory_changed');
    current.verify(); history.verify();
  });
}

export async function planRegistrationMigration(input: RegistrationInput, emit: Emit = () => {}) {
  const admission = await bindRegistrationAdmission(input, emit);
  try { return { status: 'ready' as const, planSha256: admission.planSha256, files: 7, tokenEdits: 15,
    nodeProofSha256: hash(admission.plan.node), nodeVersion: admission.plan.node.capability.version,
    sharedNode: admission.plan.node.capability.shared, sharedLibraries: admission.plan.node.libraries.length,
    processAssessment: admission.processAssessment(), clientsToClose: admission.plan.clientsToClose, otherConfigWritersMustBeClosed: true, residualRisks: registrationResidualRisks,
    filesystemWrites: 0, executionPermission: false as const }; }
  finally { admission.close(); }
}
export async function executeRegistrationMigration(input: RegistrationInput, expectedPlanSha256: string, emit: Emit = () => {}) {
  return executeRegistrationAdmission(await bindRegistrationAdmission(input, emit), expectedPlanSha256, emit);
}

/** The admission seam is used by isolated native fixtures; public commands bind the real collector. */
export async function executeRegistrationAdmission(admission: Awaited<ReturnType<typeof bindRegistrationAdmission>>, expectedPlanSha256: string, emit: Emit = () => {}) {
  let run: string | null = null, phase = 'admission', attempt: ReturnType<typeof openAttempt> | null = null;
  let result: { status: 'completed' | 'unknown' | 'stopped'; planSha256: string; runId: string | null; phase: string; errorSha256?: string; existingProcessOperations: number };
  try {
    assert.equal(admission.clientsClosed, true, 'registration_clients_must_be_closed');
    const { plan, guard, preflight } = admission, paths = managedDeploymentPaths(plan.home);
    assert.equal(hash(plan), admission.planSha256, 'registration_plan_changed'); assert.equal(admission.planSha256, expectedPlanSha256, 'registration_expected_plan_changed');
    await freshProcesses(plan, [], preflight, emit, registrationProcessProtection(plan, admission.verify));
    phase = 'prepare'; run = 'registration-migration-' + randomBytes(16).toString('hex'); emit({ phase, event: 'issued', runId: run });
    attempt = openAttempt(guard, plan, run);
    const staged = admission.originals.map((row, index) => {
      assert.equal(sha(row.edited.bytes), plan.files[index]!.afterSha256, 'registration_staged_bytes_changed');
      const bytes = row.edited.bytes, token = guard.createJournal(attempt!.directory, 'new-' + index, bytes.subarray(0, 65536));
      for (let offset = 65536; offset < bytes.length; offset += 65536) guard.appendJournal(token, bytes.subarray(offset, offset + 65536));
      const sealed = guard.sealJournalFile(token, false); assert.ok(sealed.status === 'sealed' && sealed.tree, 'registration_stage_seal_unknown'); return sealed.tree;
    });
    const model: Model = admission.originals.map((row, index) => ({ original: { place: 'config', rows: guard.readTree(row.token) }, replacement: { place: 'stage', run: run!, rows: guard.readTree(staged[index]!) } }));
    for (const [index, item] of model.entries()) assert.deepEqual(item.original.rows, plan.files[index]!.original, 'registration_original_seed_changed');
    const seed: Seed = { schema: 'caveat.registration_seed.v1', origin: run, mode: 'migration', start: structuredClone(model), directories: guard.directoryBindings(), source: null };
    writeGlobalPrivateEvidence(guard, attempt.directory, 'seed.json', seed);
    const journal = createGlobalMutationJournal(guard, attempt.directory, 'journal.jsonl', expectedPlanSha256);
    const held = admission.originals.map((row, index) => ({ original: row.token, replacement: staged[index]! }));
    const verifySync = () => { admission.verify(); attempt!.verifyLock(); verifyModel(guard, plan, seed, model, held, run!); };
    const verify = async () => { await freshProcesses(plan, [attempt!.directory], preflight, emit, registrationProcessProtection(plan, () => { assert.ok(['ready', 'complete'].includes(journal.read().status), 'registration_process_journal_unconfirmed'); verifySync(); }, model, seed.origin)); };
    for (let index = 0; index < 7; index++) {
      await verify();
      // Keep process probes and promise scheduling outside the same-file rename pair.
      for (const action of ['retain', 'publish'] as const) {
        phase = action + '.' + index; performMove(guard, journal, plan, seed, model, held, run, action, index, verifySync, emit);
      }
      await verify();
    }
    phase = 'checkpoint'; await verify(); journal.complete(hash(model)); const journalSha256 = journal.read().bytesSha256;
    const directories = guard.directoryBindings(); phase = 'close'; attempt.closeLock(); attempt = null; admission.close();
    phase = 'readback'; emit({ phase, event: 'issued', runId: run });
    await independentReadback(plan, run, expectedPlanSha256, journalSha256, model, directories);
    emit({ phase, event: 'completed', runId: run });
    result = { status: 'completed', planSha256: expectedPlanSha256, runId: run, phase, existingProcessOperations: 0 };
  } catch (error) {
    result = { status: run ? 'unknown' : 'stopped', planSha256: expectedPlanSha256, runId: run, phase, errorSha256: errorHash(error), existingProcessOperations: 0 };
  } finally {
    try { try { attempt?.closeLock(); } finally { admission.close(); } }
    catch (error) { result = { status: 'unknown', planSha256: expectedPlanSha256, runId: run, phase: 'close', errorSha256: errorHash(error), existingProcessOperations: 0 }; }
  }
  return { ...result!, processAssessment: admission.processAssessment(), residualRisks: registrationResidualRisks };
}

export async function executeRegistrationRecovery(home: string, sourceRun: string, planSha256: string, expectedEvidenceSha256: string, emit: Emit = () => {}, preflight: Preflight = preflightGlobalProcesses, clientsClosed = false) {
  const collectProcesses = preflight;
  let processAssessment: Awaited<ReturnType<Preflight>> | null = null;
  preflight = async (...args) => { processAssessment = await collectProcesses(...args); return processAssessment; };
  let run: string | null = null, phase = 'admission';
  try {
    assert.equal(clientsClosed, true, 'registration_clients_must_be_closed');
    return await withCurrent(home, sourceRun, planSha256, async (history, current, guard) => {
      const { plan, seed: oldSeed, model } = history, paths = managedDeploymentPaths(home);
      await freshProcesses(plan, history.roots.map(run => join(paths.root, run)), preflight, emit, registrationProcessProtection(plan, () => { current.verify(); history.verify(); }, model, oldSeed.origin));
      const evidenceSha256 = hash({ source: evidenceHash(history.refs), state: model, directories: guard.directoryBindings() });
      assert.equal(evidenceSha256, expectedEvidenceSha256, 'registration_expected_evidence_changed');
      assert.ok(model.some(item => item.original.place === 'backup'), 'registration_already_original');
      run = 'registration-recovery-' + evidenceSha256.slice(0, 32); phase = 'prepare';
      const attempt = openAttempt(guard, plan, run);
      try {
        const seed: Seed = { schema: 'caveat.registration_seed.v1', origin: oldSeed.origin, mode: 'recovery', start: structuredClone(model), directories: guard.directoryBindings(), source: { run: sourceRun, evidenceSha256: evidenceHash(history.refs) } };
        writeGlobalPrivateEvidence(guard, attempt.directory, 'seed.json', seed);
        const journal = createGlobalMutationJournal(guard, attempt.directory, 'journal.jsonl', planSha256);
        const verifySync = () => { current.verify(); history.verify(); attempt.verifyLock(); verifyModel(guard, plan, seed, model, current.held, run!); };
        const verify = async () => { await freshProcesses(plan, [...history.roots.map(run => join(paths.root, run)), attempt.directory], preflight, emit, registrationProcessProtection(plan, () => { assert.ok(['ready', 'complete'].includes(journal.read().status), 'registration_process_journal_unconfirmed'); verifySync(); }, model, seed.origin)); };
        for (let index = 0; index < 7; index++) {
          await verify();
          if (model[index]!.replacement.place === 'config') { phase = 'quarantine.' + index; performMove(guard, journal, plan, seed, model, current.held, run, 'quarantine', index, verifySync, emit); }
          if (model[index]!.original.place === 'backup') { phase = 'restore.' + index; performMove(guard, journal, plan, seed, model, current.held, run, 'restore', index, verifySync, emit); }
          await verify();
        }
        phase = 'checkpoint'; await verify(); journal.complete(hash(model)); const journalSha256 = journal.read().bytesSha256, directories = guard.directoryBindings();
        phase = 'close'; attempt.closeLock(); guard.close(); phase = 'readback'; emit({ phase, event: 'issued', runId: run });
        await independentReadback(plan, run, planSha256, journalSha256, model, directories);
        emit({ phase, event: 'completed', runId: run });
        return { status: 'restored' as const, planSha256, evidenceSha256, runId: run, phase, existingProcessOperations: 0, processAssessment, residualRisks: registrationResidualRisks };
      } finally { attempt.closeLock(); }
    });
  } catch (error) { return { status: run ? 'unknown' as const : 'stopped' as const, planSha256, runId: run, phase, errorSha256: errorHash(error), existingProcessOperations: 0, processAssessment, residualRisks: registrationResidualRisks }; }
}

export async function inspectRegistrationJournal(home: string, run: string, planSha256: string) {
  assert.ok(runName(run) && isAbsolute(home) && realpathSync(home) === home, 'registration_source_scope_invalid');
  const directory = join(managedDeploymentPaths(home).root, run); assert.equal(realpathSync(directory), directory, 'registration_source_alias_forbidden');
  const guard = await openGlobalPathGuard([directory]);
  try {
    guard.assertPrivateDirectory(directory);
    const plan = decodeEvidence(guard.readPersistedJournal(directory, 'plan.json')) as Plan;
    assert.equal(hash(plan), planSha256, 'registration_source_plan_changed'); validatePlan(plan, home);
    const journal = parseGlobalMutationJournal(guard.readPersistedJournal(directory, 'journal.jsonl'), planSha256);
    return { schema: 'caveat.registration_journal_inspection.v1', status: 'observed', planSha256, journalStatus: journal.status,
      journalSha256: journal.bytesSha256, currentObjects: 'not-assessed', executionPermission: false, filesystemWrites: 0, childProcesses: 0 };
  } finally { guard.close(); }
}
