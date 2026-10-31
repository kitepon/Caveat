import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { openGlobalPathGuard, type GlobalGuardTree, type GlobalGuardTreeRow } from './managedGlobalGuard.js';
import { parseGlobalMutationJournal } from './managedGlobalJournal.js';
import { digestOtherGlobals, changedOtherGlobals, snapshotOtherGlobals, observeGlobalAbsence, snapshotGlobalTree } from './managedGlobalSnapshot.js';
import { globalNpmLayout } from './platform.js';
import type { bindGlobalMigration } from './managedGlobalMigration.js';

type Plan = Awaited<ReturnType<typeof bindGlobalMigration>>['plan'];
type OriginalManifest = ReturnType<Awaited<ReturnType<typeof bindGlobalMigration>>['engine']['manifest']>;
type ShellState = ReturnType<Awaited<ReturnType<typeof bindGlobalMigration>>['shell']['snapshot']>;
export const digestGlobalRecoveryBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const shaGlobalRecoveryValue = (value: unknown) => digestGlobalRecoveryBytes(Buffer.from(JSON.stringify(value)));
export const globalRecoveryKeys = (value: unknown, expected: string[]) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'global_recovery_object_required');
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'global_recovery_fields_invalid');
};
export function globalRecoveryRows(value: unknown): asserts value is GlobalGuardTreeRow[] {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 100000, 'global_recovery_rows_bound');
  const names = new Set<string>();
  for (const row of value) {
    globalRecoveryKeys(row, ['relativePath', 'identity']);
    assert.ok(typeof row.relativePath === 'string' && !names.has(row.relativePath) && row.relativePath.length <= 32768
      && !/[\\\x00-\x1f:]/.test(row.relativePath) && (row.relativePath === '' || row.relativePath.split('/').every((part: string) => part && part !== '.' && part !== '..')), 'global_recovery_row_path_invalid');
    names.add(row.relativePath); const id = row.identity;
    assert.ok(id && typeof id === 'object' && ['file', 'directory', 'link'].includes(id.kind)
      && ['dev', 'ino', 'size', 'links', 'mtime', 'ctime', 'owner', 'group'].every(key => typeof id[key] === 'string')
      && Number.isSafeInteger(id.mode) && id.mode >= 0 && id.mode <= 0xffffffff, 'global_recovery_identity_invalid');
    assert.ok(id.kind !== 'file' || typeof id.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(id.contentSha256), 'global_recovery_content_hash_invalid');
  }
  assert.equal(value[0].relativePath, '', 'global_recovery_root_row_required');
};

type Binding = { directory: string; name: string; rows: GlobalGuardTreeRow[] | null; tree: GlobalGuardTree | null };
export type GlobalRecoverySnapshot = { plan: Plan; original: OriginalManifest; shell: ShellState | undefined;
  guard: Awaited<ReturnType<typeof openGlobalPathGuard>>; bindings: Map<string, Binding>; evidenceSha256: string; journalSha256: string;
  observations?: { step: string; state: string; reason?: string; diagnostic?: unknown }[];
  proposal?: { kind: 'rollback-known'; automaticExecution: false; objects: string[] }; journalDiagnostic?: { status: string; lastEvent: unknown };
  verifyEvidence: () => void; verifyProtected: () => void; admission?: unknown; sourceRoots?: string[]; vacancySlots?: { directory: string; name: string }[] };

/** Diagnostics are bounded; object contents stay in the private evidence. */
export function assertGlobalRecoveryBinding(read: () => GlobalGuardTreeRow[] | null, expected: GlobalGuardTreeRow[] | null, directory: string, name: string) {
  let actual: GlobalGuardTreeRow[] | null = null, observed = false;
  try { actual = read(); observed = true; assert.deepEqual(actual, expected, 'global_recovery_binding_changed'); }
  catch (cause) {
    const before = new Map((expected ?? []).map(row => [row.relativePath, row.identity]));
    const after = new Map((actual ?? []).map(row => [row.relativePath, row.identity]));
    const records: { relativePath: string; attributes: string[] }[] = [];
    for (const path of observed ? new Set([...before.keys(), ...after.keys()]) : []) {
      const a = before.get(path), b = after.get(path);
      const attributes = !a || !b ? ['presence'] : Object.keys({ ...a, ...b }).filter(key => a[key as keyof typeof a] !== b[key as keyof typeof b]);
      if (attributes.length) records.push({ relativePath: path, attributes });
      if (records.length === 16) break;
    }
    throw Object.assign(Error('global_recovery_binding_changed', { cause }), { diagnostic: { directory, name, path: join(directory, name), records,
      ...(!observed ? { observation: 'unavailable', code: (cause as NodeJS.ErrnoException)?.code ?? null } : {}) } });
  }
}

export function globalRecoveryGuardPaths(plan: Plan, runDirectory: string) {
  return [...new Set([runDirectory, plan.root, plan.globalRoot, plan.binDirectory,
    dirname(dirname(plan.baseline.npm.executable)), ...plan.absences.map(row => row.parent), ...plan.protectedObjects.map(row => dirname(row.path))])];
}

/** Shared immutable binding for admission, recovery mutations and independent recovery readback. */
export function bindGlobalRecoveryProtected(plan: Plan, guard: Awaited<ReturnType<typeof openGlobalPathGuard>>) {
  const bindings = new Map<string, Binding>();
  for (const [index, object] of plan.protectedObjects.entries()) {
    const binding: Binding = { directory: dirname(object.path), name: basename(object.path), rows: object.rows, tree: null };
    try { binding.tree = guard.retainTree(binding.directory, binding.name, 'protected'); } catch { /* Unknown remains a permanent failed binding. */ }
    bindings.set('protected.' + index, binding);
  }
  const observe = () => {
    const checks: { step: string; state: 'known' | 'absent' | 'unknown'; reason?: string; diagnostic?: unknown; records?: { package: string; reason: string }[] }[] = [];
    guard.assertCurrent();
    for (const [step, binding] of bindings) if (step.startsWith('protected.')) {
      try { assertGlobalRecoveryBinding(() => guard.readTree(binding.tree!), binding.rows, binding.directory, binding.name); checks.push({ step, state: 'known' }); }
      catch (error) { checks.push({ step, state: 'unknown', reason: (error as Error).message, diagnostic: (error as { diagnostic?: unknown }).diagnostic }); }
    }
    if (plan.baseline.npmManagement.absent) {
      try { assert.equal(guard.observe(plan.globalRoot, '.package-lock.json'), null, 'global_recovery_management_appeared'); checks.push({ step: 'absent-management', state: 'absent' }); }
      catch (error) { checks.push({ step: 'absent-management', state: 'unknown', reason: (error as Error).message,
        diagnostic: { path: join(plan.globalRoot, '.package-lock.json') } }); }
    }
    const directories = guard.directoryBindings();
    for (const [index, row] of plan.directories.entries()) {
      const current = directories.find(value => value.path === row.path);
      try { assert.deepEqual(current, row, 'global_recovery_directory_changed'); checks.push({ step: 'directory.' + index, state: 'known' }); }
      catch (error) { checks.push({ step: 'directory.' + index, state: 'unknown', reason: (error as Error).message,
        diagnostic: { directory: dirname(row.path), name: basename(row.path), path: row.path,
          records: [{ relativePath: '', attributes: current ? Object.keys(row).filter(key => row[key as keyof typeof row] !== current[key as keyof typeof current]) : ['presence'] }] } }); }
    }
    for (const [index, row] of plan.absences.entries()) {
      try { assert.deepEqual(observeGlobalAbsence(row.path), row, 'global_recovery_absence_changed'); checks.push({ step: 'absent-config.' + index, state: 'absent' }); }
      catch (error) { checks.push({ step: 'absent-config.' + index, state: 'unknown', reason: (error as Error).message, diagnostic: { path: row.path } }); }
    }
    for (const [index, alias] of plan.aliases.entries()) {
      // Original package names may legitimately be absent after preservation/removal.
      if (alias.path === plan.baseline.packageRoot) continue;
      try { assert.equal(realpathSync(alias.path), alias.canonical, 'global_recovery_alias_changed'); checks.push({ step: 'alias.' + index, state: 'known' }); }
      catch (error) { checks.push({ step: 'alias.' + index, state: 'unknown', reason: (error as Error).message, diagnostic: { path: alias.path } }); }
    }
    for (const [step, observed, expected] of [
      ['npm', () => snapshotGlobalTree(dirname(dirname(plan.baseline.npm.executable)), { observeOnly: true, opaqueExternalLinks: true }), plan.baseline.npm.tree],
    ] as const) {
      try { assert.deepEqual(observed(), expected, 'global_recovery_npm_changed'); checks.push({ step, state: 'known' }); } catch (error) { checks.push({ step, state: 'unknown', reason: (error as Error).message, diagnostic: (error as { diagnostic?: unknown }).diagnostic }); }
    }
    try {
      const actual = snapshotOtherGlobals(plan.globalRoot), records = changedOtherGlobals(actual, plan.baseline.otherGlobals);
      checks.push({ step: 'other-globals', state: actual.sha256 !== (Array.isArray(plan.baseline.otherGlobals) ? digestOtherGlobals(plan.baseline.otherGlobals) : plan.baseline.otherGlobals).sha256 ? 'unknown' : 'known', ...(records.length ? { records } : {}) });
    } catch { checks.push({ step: 'other-globals', state: 'unknown' }); }
    return checks;
  };
  return { observe, verify() { assert.ok(observe().every(row => row.state === 'known' || row.state === 'absent'), 'global_recovery_protected_state_changed'); } };
}

/** Read-only inspection, never an execution permit. Interrupted/unknown actions cannot be replayed here. */
export function inspectGlobalMigrationRecovery(runDirectory: string, expectedPlanSha256: string) {
  return withGlobalRecoverySnapshot(runDirectory, expectedPlanSha256);
}

export type GlobalRecoveryBudget = { files: number; bytes: number };
export type GlobalMigrationEvidence = Omit<GlobalRecoverySnapshot, 'guard' | 'bindings' | 'verifyProtected'> & {
  journalStatus: ReturnType<typeof parseGlobalMutationJournal>['status']; recoveryEligible: boolean;
  journalDiagnostic: { status: string; lastEvent: unknown };
  references: { run: string; name: string; bytes: number; sha256: string }[] };

/** Decode source history without pretending that old object names still contain the objects. */
export async function withGlobalMigrationEvidence<T>(runDirectory: string, expectedPlanSha256: string, use: (source: GlobalMigrationEvidence) => Promise<T>, budget: GlobalRecoveryBudget = { files: 0, bytes: 0 }) {
  assert.ok(isAbsolute(runDirectory) && resolve(runDirectory) === runDirectory && /^global-migration-[a-f0-9]{32}$/.test(basename(runDirectory)), 'global_recovery_run_path_invalid');
  assert.equal(realpathSync(runDirectory), runDirectory, 'global_recovery_source_alias_forbidden');
  const evidence = await openGlobalPathGuard([runDirectory]);
  try {
    evidence.assertPrivateDirectory(runDirectory); assert.equal(realpathSync(runDirectory), runDirectory, 'global_recovery_source_alias_forbidden');
    const cached = new Map<string, Buffer>(); let totalBytes = 0;
    const read = (name: string) => {
      const known = cached.get(name); if (known) return known;
      const bytes = evidence.readPersistedJournal(runDirectory, name); totalBytes += bytes.length; budget.files++; budget.bytes += bytes.length;
      assert.ok(budget.files <= 256 && budget.bytes <= 64 * 1024 * 1024, 'global_recovery_chain_evidence_bound');
      assert.ok(cached.size < 256 && totalBytes <= 64 * 1024 * 1024, 'global_recovery_total_evidence_bound'); cached.set(name, bytes); return bytes;
    };
    const decode = (bytes: Buffer) => {
      const value: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      assert.equal(Buffer.from(JSON.stringify(value) + '\n').compare(bytes), 0, 'global_recovery_noncanonical_json'); return value;
    };
    const planBytes = read('plan.json'); assert.equal(shaGlobalRecoveryValue(decode(planBytes)), expectedPlanSha256, 'global_recovery_plan_hash_changed');
    const plan = decode(planBytes) as Plan;
    globalRecoveryKeys(plan, ['schema', 'baseline', 'leaves', 'protectedObjects', 'prefix', 'root', 'globalRoot', 'binDirectory', 'shellPlan', 'aliases', 'absences', 'directories', ...(Object.hasOwn(plan, 'originalObjects') ? ['originalObjects'] : []), ...(Object.hasOwn(plan, 'nodeProof') ? ['nodeProof'] : [])]);
    assert.equal(plan.schema, 'caveat.global_migration_plan.v1', 'global_recovery_plan_invalid');
    assert.equal(plan.root, dirname(runDirectory), 'global_recovery_run_outside_root');
    assert.ok([plan.root, plan.globalRoot, plan.binDirectory, plan.prefix].every(path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path), 'global_recovery_absolute_scope_required');
    const layout = globalNpmLayout(plan.globalRoot);
    assert.equal(layout.prefix, plan.prefix, 'global_recovery_prefix_invalid'); assert.equal(layout.binDirectory, plan.binDirectory, 'global_recovery_bin_invalid');
    assert.ok(Array.isArray(plan.leaves) && plan.leaves.length >= 1 && plan.leaves.length <= 3
      && new Set(plan.leaves.map(row => row.name)).size === plan.leaves.length
      && plan.leaves.every(row => ['caveat', 'caveat.cmd', 'caveat.ps1'].includes(row.name)), 'global_recovery_leaf_scope_invalid');
    for (const leaf of plan.leaves) { globalRecoveryKeys(leaf, ['name', 'identity']); if (leaf.identity !== null) globalRecoveryRows([{ relativePath: '', identity: leaf.identity }]); }
    assert.ok(Array.isArray(plan.aliases) && plan.aliases.length <= 32 && plan.aliases.every(row => typeof row.path === 'string' && isAbsolute(row.path) && typeof row.canonical === 'string' && isAbsolute(row.canonical)), 'global_recovery_alias_scope_invalid');
    assert.ok(Array.isArray(plan.absences) && plan.absences.length <= 16 && plan.absences.every(row => typeof row.path === 'string' && isAbsolute(row.path) && typeof row.parent === 'string' && isAbsolute(row.parent)), 'global_recovery_absence_invalid');
    assert.ok(Array.isArray(plan.directories) && plan.directories.length <= 512, 'global_recovery_directory_bound');
    const journal = parseGlobalMutationJournal(read('journal.jsonl'), expectedPlanSha256);
    const base = { schema: 'caveat.global_recovery_inspection.v1' as const, planSha256: expectedPlanSha256, journalStatus: journal.status, journalSha256: journal.bytesSha256,
      filesystemWrites: 0, childProcesses: 0, automaticRecovery: false as const, executionPermission: false as const };
    const results = journal.records.filter(row => row.kind === 'result');
    if (!results.length) return { ...base, status: journal.status === 'ready' || journal.status === 'complete' ? 'observed' as const : 'stopped' as const,
      reason: journal.status === 'ready' || journal.status === 'complete' ? 'no_recorded_mutation' : 'interrupted_or_unknown', observations: [],
      diagnostic: { journal: { status: journal.status, lastEvent: journal.records.at(-1) ?? null } },
      proposal: { kind: 'rollback-known' as const, automaticExecution: false as const, objects: [] as string[] } };
    let original: OriginalManifest | undefined, shell: ShellState | undefined;
    let recoveryEligible = ['ready', 'complete'].includes(journal.status), lastEvent: unknown = journal.records.at(-1) ?? null;
    for (const result of results) {
      if (result.stateSha256 === null) continue;
      const bytes = read('state-' + journal.header.runId + '-' + result.sequence + '.json');
      assert.equal(digestGlobalRecoveryBytes(bytes), result.stateSha256, 'global_recovery_state_hash_changed');
      const value = decode(bytes) as { schema: string; planSha256: string; runId: string; step: string; operation: string; manifest: OriginalManifest; shell?: ShellState;
        result?: { verificationFailed?: boolean; reason?: string; diagnostic?: unknown }; errorSha256?: string };
      assert.ok(['caveat.global_preservation_state.v1', 'caveat.global_shell_operation.v1'].includes(value.schema)
        && value.planSha256 === expectedPlanSha256 && value.runId === journal.header.runId && value.step === result.step && value.operation === result.operation, 'global_recovery_state_binding_invalid');
      const previousOriginal = original, previousShell = shell;
      original = value.manifest;
      // A failed read-only verification cannot undo the immediately preceding confirmed publication.
      if (result === journal.records.at(-1)) {
        const diagnostic = value.result?.diagnostic ?? null;
        lastEvent = { ...result, reason: typeof value.result?.reason === 'string' ? value.result.reason.slice(0, 8192) : null,
          diagnostic: Buffer.byteLength(JSON.stringify(diagnostic)) <= 65536 ? diagnostic : { truncated: true, sha256: shaGlobalRecoveryValue(diagnostic) },
          errorSha256: value.errorSha256 ?? null };
        const prior = journal.records.at(-3);
        if (journal.status === 'unknown' && result.outcome === 'unknown' && result.step.startsWith('verify.')
          && prior?.kind === 'result' && prior.outcome === 'confirmed' && result.step === 'verify.' + prior.step
          && result.operation === prior.operation && value.result?.verificationFailed === true && previousOriginal && previousShell && value.shell) {
          const candidate = structuredClone(value.shell), name = result.step.slice('verify.publish.generated.'.length);
          const current = [...candidate.files, candidate.manifest].find(row => row.name === name);
          const before = [...previousShell.files, previousShell.manifest].find(row => row.name === name);
          if (result.step.startsWith('verify.publish.generated.') && current?.status === 'unknown' && before?.status === 'installed') {
            assert.equal(journal.records.at(-2)?.stateSha256, shaGlobalRecoveryValue(value.shell), 'global_recovery_verify_intent_unbound');
            current.status = 'installed';
            assert.deepEqual(value.manifest, previousOriginal, 'global_recovery_verify_originals_changed');
            assert.deepEqual(candidate, previousShell, 'global_recovery_verify_publication_changed');
            value.shell = candidate; recoveryEligible = true;
          }
        }
      }
      assert.equal(original.schema, 'caveat.global_original_objects.v1', 'global_recovery_originals_invalid');
      globalRecoveryKeys(original, ['schema', 'objects', 'originalEvidence', 'originalsReconstructed', 'automaticRecovery']);
      assert.ok(original.originalsReconstructed === false && original.automaticRecovery === false, 'global_recovery_reconstruction_forbidden');
      const reference = original.originalEvidence; globalRecoveryKeys(reference, ['name', 'bytes', 'sha256']);
      assert.equal(reference.name, 'originals-' + journal.header.runId + '.json', 'global_recovery_original_reference_invalid');
      const originals = read(reference.name); assert.equal(originals.length, reference.bytes, 'global_recovery_original_size_changed');
      assert.equal(digestGlobalRecoveryBytes(originals), reference.sha256, 'global_recovery_original_hash_changed');
      const seed = decode(originals) as { schema: string; planSha256: string; runId: string; objects: OriginalManifest['objects'] };
      assert.ok(seed.schema === 'caveat.global_original_evidence.v1' && seed.planSha256 === expectedPlanSha256 && seed.runId === journal.header.runId, 'global_recovery_original_binding_invalid');
      assert.ok(Array.isArray(original.objects) && original.objects.length >= 1 && original.objects.length <= 5 && seed.objects.length === original.objects.length, 'global_recovery_object_scope_invalid');
      assert.equal(new Set(original.objects.map(row => row.step)).size, original.objects.length, 'global_recovery_duplicate_step');
      if (Object.hasOwn(plan, 'originalObjects')) {
        assert.ok(Array.isArray(plan.originalObjects) && plan.originalObjects.length === original.objects.length, 'global_recovery_plan_originals_required');
        assert.equal(new Set(plan.originalObjects.map(row => row.step)).size, original.objects.length, 'global_recovery_duplicate_plan_original');
        for (const row of plan.originalObjects) globalRecoveryKeys(row, ['step', 'role', 'directory', 'name', 'rows']);
      }
      const expectedSteps = ['package', ...(!plan.baseline.npmManagement.absent ? ['management'] : []), ...plan.leaves.filter(row => row.identity).map(row => row.name.replaceAll('.', '-'))];
      assert.deepEqual(original.objects.map(row => row.step).sort(), expectedSteps.sort(), 'global_recovery_missing_original');
      for (const [index, object] of original.objects.entries()) {
        globalRecoveryKeys(object, ['step', 'role', 'directory', 'name', 'backupDirectory', 'backupName', 'state', 'working', 'rows', 'stateSha256']);
        const expected = seed.objects[index]!; globalRecoveryKeys(expected, ['step', 'role', 'directory', 'name', 'backupDirectory', 'backupName', 'rows']);
        assert.ok(object.role === 'package' && object.name === 'caveat-cli' && object.step === 'package' && object.backupName === 'original-package' && object.directory === plan.globalRoot
          || object.role === 'npm-management' && object.name === '.package-lock.json' && object.step === 'management' && object.backupName === 'original-management' && object.directory === plan.globalRoot
          || object.role === 'leaf' && plan.leaves.some(row => row.name === object.name && row.identity !== null) && object.step === object.name.replaceAll('.', '-') && object.backupName === 'original-' + object.name && object.directory === plan.binDirectory, 'global_recovery_original_scope_invalid');
        if (Object.hasOwn(plan, 'originalObjects')) {
          const anchor = plan.originalObjects.find(row => row.step === object.step); assert.ok(anchor, 'global_recovery_original_anchor_required');
          for (const key of ['step', 'role', 'directory', 'name'] as const) assert.equal(expected[key], anchor[key], 'global_recovery_original_anchor_scope_changed');
          globalRecoveryRows(anchor.rows); assert.deepEqual(expected.rows, anchor.rows, 'global_recovery_original_seed_unbound');
        }
        assert.equal(object.backupDirectory, runDirectory, 'global_recovery_backup_scope_invalid');
        for (const key of ['role', 'step', 'name', 'directory', 'backupDirectory', 'backupName'] as const) assert.equal(object[key], expected[key], 'global_recovery_original_scope_changed');
        assert.ok(['original', 'preserved', 'restored', ...(!recoveryEligible ? ['unknown'] : [])].includes(object.state), 'global_recovery_original_unknown');
        globalRecoveryRows(object.rows); globalRecoveryRows(expected.rows); assert.equal(shaGlobalRecoveryValue(object.rows), object.stateSha256, 'global_recovery_original_rows_changed');
        const known = structuredClone(expected.rows); known[0]!.identity.ctime = object.rows[0]!.identity.ctime;
        assert.deepEqual(object.rows, known, 'global_recovery_original_identity_changed');
        if (object.working) {
          globalRecoveryKeys(object.working, ['status', 'rows', 'stagingName']);
          assert.ok(['known', 'after-known', 'absent', 'quarantined', ...(!recoveryEligible ? ['unknown', 'released'] : [])].includes(object.working.status)
            && object.working.stagingName === 'work-' + journal.header.runId + '-' + object.step, 'global_recovery_working_unknown');
          if (object.working.rows !== null) {
            globalRecoveryRows(object.working.rows);
            const source = new Map(expected.rows.map(row => [row.relativePath, row.identity]));
            for (const row of object.working.rows) {
              const before = source.get(row.relativePath); assert.ok(before, 'global_recovery_working_path_unbound');
              assert.deepEqual([row.identity.kind, row.identity.contentSha256, row.identity.linkTarget],
                [before.kind, before.contentSha256, before.linkTarget], 'global_recovery_working_content_unbound');
            }
          }
          else assert.ok(['absent', ...(!recoveryEligible ? ['unknown', 'released'] : [])].includes(object.working.status), 'global_recovery_working_rows_required');
        }
      }
      if (value.schema === 'caveat.global_shell_operation.v1') {
        shell = value.shell;
        assert.ok(shell && shell.schema === 'caveat.global_shell_objects.v1' && shell.files.length === plan.leaves.length, 'global_recovery_shell_invalid');
        for (const [index, object] of [...shell.files, shell.manifest].entries()) {
          assert.equal(object.name, index < shell.files.length ? plan.leaves[index]!.name : 'shell', 'global_recovery_shell_scope_invalid');
          assert.equal(object.backupName, index < shell.files.length ? 'generated-' + index : 'generated-shell', 'global_recovery_shell_backup_invalid');
          assert.ok(['absent', 'installed', 'quarantined', ...(!recoveryEligible ? ['unknown'] : [])].includes(object.status), 'global_recovery_shell_unknown');
          if (object.status === 'absent') assert.equal(object.rows, null, 'global_recovery_shell_rows_invalid');
          else if (object.rows !== null || object.status !== 'unknown') {
            globalRecoveryRows(object.rows);
            if (index < shell.files.length) {
              assert.equal(object.rows.length, 1, 'global_recovery_wrapper_rows_invalid');
              const reviewed = plan.shellPlan.files.find(row => row.name === object.name); assert.ok(reviewed, 'global_recovery_wrapper_plan_missing');
              assert.equal(object.rows[0]!.identity.contentSha256, reviewed.sha256, 'global_recovery_wrapper_content_unbound');
            }
          }
        }
      }
    }
    assert.ok(original, 'global_recovery_originals_required');
    assert.ok(Array.isArray(plan.protectedObjects) && plan.protectedObjects.length <= 16, 'global_recovery_protected_bound');
    for (const object of plan.protectedObjects) { assert.ok(isAbsolute(object.path) && resolve(object.path) === object.path, 'global_recovery_protected_path_invalid'); globalRecoveryRows(object.rows); }
    const verifyEvidence = () => { assert.equal(realpathSync(runDirectory), runDirectory, 'global_recovery_source_alias_forbidden'); for (const [name, bytes] of cached) assert.ok(evidence.readPersistedJournal(runDirectory, name).equals(bytes), 'global_recovery_evidence_changed_during_read'); };
    verifyEvidence();
    const evidenceSha256 = shaGlobalRecoveryValue([...cached].map(([name, bytes]) => ({ name, sha256: digestGlobalRecoveryBytes(bytes) })).sort((a, b) => a.name.localeCompare(b.name)));
    return await use({ plan, original, shell, evidenceSha256, journalSha256: journal.bytesSha256, verifyEvidence,
      journalStatus: journal.status, recoveryEligible, journalDiagnostic: { status: journal.status, lastEvent },
      references: [...cached].map(([name, bytes]) => ({ run: basename(runDirectory), name, bytes: bytes.length, sha256: digestGlobalRecoveryBytes(bytes) })) });

  } finally { evidence.close(); }
}

/** Internal scoped lease: all source files are read-only; native objects stay held while use runs. */
export function withGlobalRecoverySnapshot<T = never>(runDirectory: string, expectedPlanSha256: string, use?: (snapshot: GlobalRecoverySnapshot) => Promise<T>) {
  return withGlobalMigrationEvidence(runDirectory, expectedPlanSha256, async source => {
    const { plan, original, shell, evidenceSha256, journalSha256, journalStatus, verifyEvidence, recoveryEligible, journalDiagnostic } = source;
    const guard = await openGlobalPathGuard(globalRecoveryGuardPaths(plan, runDirectory));
    try {
      guard.assertPrivateDirectory(runDirectory);
      const observations: { step: string; state: 'known' | 'absent' | 'changed' | 'unknown'; reason?: string; diagnostic?: unknown }[] = [], bindings = new Map<string, Binding>();
      const check = (step: string, directory: string, name: string, expected: GlobalGuardTreeRow[] | null) => {
        try {
          const tree = expected ? guard.retainTree(directory, name) : null;
          if (!tree) { assertGlobalRecoveryBinding(() => { const value = guard.observe(directory, name); return value ? [{ relativePath: '', identity: value }] : null; }, null, directory, name); observations.push({ step, state: 'absent' }); }
          else { assertGlobalRecoveryBinding(() => guard.readTree(tree), expected, directory, name); observations.push({ step, state: 'known' }); }
          bindings.set(step, { directory, name, rows: structuredClone(expected), tree });
        } catch (error) { observations.push({ step, state: 'unknown', reason: (error as Error).message, diagnostic: (error as { diagnostic?: unknown }).diagnostic ?? { directory, name, path: join(directory, name) } }); }
      };
      for (const object of original.objects) {
        if (object.state === 'unknown') {
          check('original.candidate.' + object.step, object.directory, object.name, object.rows);
          check('original.backup.' + object.step, runDirectory, object.backupName, object.rows);
          observations.push({ step: 'original.' + object.step, state: 'unknown', reason: 'journal_operation_unconfirmed',
            diagnostic: { directory: object.directory, name: object.name, path: join(object.directory, object.name) } });
        } else check('original.' + object.step, object.state === 'preserved' ? runDirectory : object.directory, object.state === 'preserved' ? object.backupName : object.name, object.rows);
        if (object.working?.status === 'quarantined') check('quarantined.' + object.step, runDirectory, 'used-' + object.working.stagingName, object.working.rows);
        if (object.state === 'preserved') {
          const installed = shell?.files.find(row => row.name === object.name && row.status === 'installed');
          if (!installed && object.working?.status !== 'quarantined') check('working.' + object.step, object.directory, object.name, object.working?.rows ?? null);
          if (object.working?.status === 'quarantined') check('vacant.' + object.step, object.directory, object.name, null);
        }
      }
      for (const leaf of plan.leaves) if (!leaf.identity && !shell?.files.some(row => row.name === leaf.name && row.status === 'installed')) check('absent.' + leaf.name, plan.binDirectory, leaf.name, null);
      for (const object of shell ? [...shell.files, shell.manifest] : []) if (object.status !== 'absent') {
        check('generated.' + object.name, object.status === 'quarantined' ? runDirectory : object.name === 'shell' ? plan.root : plan.binDirectory,
          object.status === 'quarantined' ? 'used-' + object.backupName : object.name, object.rows);
      }
      const protectedState = bindGlobalRecoveryProtected(plan, guard);
      observations.push(...protectedState.observe());
      // A concurrent edit of any previously read evidence invalidates this entire inspection.
      verifyEvidence();
      const changed = observations.some(row => row.state === 'changed' || row.state === 'unknown');
      const proposal = { kind: 'rollback-known' as const, automaticExecution: false as const,
        objects: observations.filter(row => row.state === 'known' && (original.objects.some(object => ['original.', 'working.', 'quarantined.'].some(prefix => row.step === prefix + object.step))
          || row.step.startsWith('generated.'))).map(row => row.step) };
      if (use && !changed && recoveryEligible) return await use({ plan, original, shell, guard, bindings, evidenceSha256, journalSha256, verifyEvidence,
        verifyProtected: protectedState.verify, ...(journalStatus === 'unknown' ? { observations, proposal, journalDiagnostic } : {}) });
      return { schema: 'caveat.global_recovery_inspection.v1' as const, planSha256: expectedPlanSha256, journalStatus, journalSha256, filesystemWrites: 0, childProcesses: 0, automaticRecovery: false as const, executionPermission: false as const, evidenceSha256,
        status: changed || !recoveryEligible ? 'stopped' as const : 'observed' as const,
        reason: !recoveryEligible ? 'interrupted_or_unknown' : changed ? 'current_state_unconfirmed' : 'recorded_state_matches', observations,
        diagnostic: { journal: journalDiagnostic }, proposal };
    } finally { guard.close(); }
  });
}
