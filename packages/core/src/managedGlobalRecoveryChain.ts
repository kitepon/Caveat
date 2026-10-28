import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { bindGlobalRecoveryProtected, globalRecoveryGuardPaths, globalRecoveryKeys, shaGlobalRecoveryValue,
  withGlobalMigrationEvidence, withGlobalRecoverySnapshot, type GlobalMigrationEvidence, type GlobalRecoverySnapshot } from './managedGlobalRecovery.js';
import { withGlobalRecoveryAttemptEvidence } from './managedGlobalRecoveryAttempt.js';
import { recoveryLocations, recoveryModelFromMigration, recoveryVacancySlots, validateRecoveryJournalState, type RecoveryModel } from './managedGlobalRecoveryModel.js';
import { openGlobalPathGuard } from './managedGlobalGuard.js';
import { preflightGlobalProcesses } from './managedGlobalProcesses.js';
import { nativeGlobalProcessTables, type ProcessProbeEvent } from './managedProcessNative.js';
import { managedNodePaths } from './managedNode.js';

type Reference = GlobalMigrationEvidence['references'][number];
type Chain = { origin: GlobalMigrationEvidence; model: RecoveryModel; roots: string[]; references: Reference[];
  evidenceSha256: string; journalSha256: string; verifyEvidence: () => void };
type Admission = { schema: 'caveat.global_recovery_admission.v1'; planSha256: string; sourceRun: string; sourceDataSha256: string;
  state: RecoveryModel; directories: ReturnType<GlobalRecoverySnapshot['guard']['directoryBindings']> };
const orderedReferences = (references: Reference[]) => [...references].sort((a, b) => a.run.localeCompare(b.run) || a.name.localeCompare(b.name));

/** Callback leases keep every source file read-only until all fresh current-object checks finish. */
async function withRecoveryChain<T>(runDirectory: string, planSha256: string, use: (chain: Chain) => Promise<T>,
  seen = new Set<string>(), budget = { files: 0, bytes: 0 }): Promise<T> {
  assert.ok(seen.size < 8 && !seen.has(runDirectory), 'global_recovery_chain_cycle_or_bound'); seen.add(runDirectory);
  if (basename(runDirectory).startsWith('global-migration-')) {
    let validated = false;
    const result = await withGlobalMigrationEvidence(runDirectory, planSha256, async origin => { validated = true; return use({ origin,
      model: recoveryModelFromMigration(origin, runDirectory), roots: [runDirectory], references: origin.references,
      evidenceSha256: origin.evidenceSha256, journalSha256: origin.journalSha256, verifyEvidence: origin.verifyEvidence }); }, budget);
    assert.ok(validated, 'global_recovery_source_unconfirmed');
    return result as T;
  }
  return withGlobalRecoveryAttemptEvidence(runDirectory, planSha256, async attempt => {
    assert.ok(['ready', 'complete'].includes(attempt.journal.status)
      && attempt.journal.records.every(row => row.kind !== 'result' || row.outcome === 'confirmed'), 'global_recovery_chain_unconfirmed_intent');
    const parent = join(dirname(runDirectory), attempt.source.sourceRun);
    return withRecoveryChain(parent, planSha256, async chain => {
      assert.equal(chain.origin.plan.root, dirname(runDirectory), 'global_recovery_chain_outside_root');
      assert.equal(attempt.source.journalSha256, chain.journalSha256, 'global_recovery_chain_source_journal_changed');
      const isMigration = basename(parent).startsWith('global-migration-');
      if (isMigration) {
        assert.equal(attempt.source.evidenceSha256, chain.evidenceSha256, 'global_recovery_chain_source_changed');
        assert.ok(attempt.source.schema === 'caveat.global_recovery_source.v1' || attempt.source.admission === null, 'global_recovery_chain_migration_admission_invalid');
      } else {
        assert.equal(attempt.source.schema, 'caveat.global_recovery_source.v2', 'global_recovery_chain_admission_required');
        const admission = attempt.source.admission as Admission;
        globalRecoveryKeys(admission, ['schema', 'planSha256', 'sourceRun', 'sourceDataSha256', 'state', 'directories']);
        assert.ok(admission.schema === 'caveat.global_recovery_admission.v1' && admission.planSha256 === planSha256
          && admission.sourceRun === basename(parent) && admission.sourceDataSha256 === shaGlobalRecoveryValue(orderedReferences(chain.references)), 'global_recovery_chain_admission_unbound');
        assert.deepEqual(admission.state, chain.model, 'global_recovery_chain_admission_state_changed');
        assert.ok(Array.isArray(admission.directories) && admission.directories.length > 0 && admission.directories.length <= 512, 'global_recovery_chain_directory_bound');
        assert.equal(shaGlobalRecoveryValue(admission), attempt.source.evidenceSha256, 'global_recovery_chain_admission_digest_changed');
      }
      const model = structuredClone(chain.model); model.sourceEvidenceSha256 = attempt.source.evidenceSha256;
      validateRecoveryJournalState(model, attempt.journal, attempt.states, chain.origin, runDirectory);
      const verifyEvidence = () => { chain.verifyEvidence(); attempt.verifyEvidence(); }; verifyEvidence();
      return use({ ...chain, model, roots: [...chain.roots, runDirectory], references: [...chain.references, ...attempt.references],
        evidenceSha256: attempt.source.evidenceSha256, journalSha256: attempt.journal.bytesSha256, verifyEvidence });
    }, seen, budget);
  }, budget);
}

/** Paths come exclusively from the validated original seed and its fixed, confirmed transitions. */
export function withGlobalRecoverySourceSnapshot<T>(runDirectory: string, planSha256: string, use: (source: GlobalRecoverySnapshot) => Promise<T>) {
  if (basename(runDirectory).startsWith('global-migration-')) return withGlobalRecoverySnapshot(runDirectory, planSha256, use);
  return withRecoveryChain(runDirectory, planSha256, async chain => {
    const { origin, model } = chain, plan = origin.plan;
    const slots = recoveryVacancySlots(origin, chain.roots);
    const paths = [...new Set([...globalRecoveryGuardPaths(plan, chain.roots[0]!), ...chain.roots,
      ...recoveryLocations(model).map(row => row.directory), ...slots.map(row => row.directory)])];
    const guard = await openGlobalPathGuard(paths);
    try {
      for (const root of chain.roots) guard.assertPrivateDirectory(root);
      const bindings: GlobalRecoverySnapshot['bindings'] = new Map();
      const bind = (key: string, row: ReturnType<typeof recoveryLocations>[number]) => {
        const tree = guard.retainTree(row.directory, row.name);
        assert.deepEqual(guard.readTree(tree), row.rows, 'global_recovery_chain_current_object_changed');
        bindings.set(key, { ...structuredClone(row), tree });
      };
      for (const row of model.objects) {
        bind('original.' + row.step, row.original);
        if (row.workingEntry) bind((row.working!.status === 'quarantined' ? 'quarantined.' : 'working.') + row.step, row.workingEntry);
      }
      for (const row of model.generated) if (row.entry) bind('generated.' + row.name, row.entry);
      const occupied = new Set<string>();
      for (const row of recoveryLocations(model)) { const path = join(row.directory, row.name); assert.ok(!occupied.has(path), 'global_recovery_chain_overlapping_object'); occupied.add(path); }
      for (const row of slots) if (!occupied.has(join(row.directory, row.name))) assert.equal(guard.observe(row.directory, row.name), null, 'global_recovery_chain_unknown_name');
      const protectedState = bindGlobalRecoveryProtected(plan, guard); protectedState.verify(); chain.verifyEvidence();
      const admission: Admission = { schema: 'caveat.global_recovery_admission.v1', planSha256, sourceRun: basename(runDirectory),
        sourceDataSha256: shaGlobalRecoveryValue(orderedReferences(chain.references)), state: structuredClone(model), directories: guard.directoryBindings() };
      const original = structuredClone(origin.original);
      for (const object of original.objects) {
        const row = model.objects.find(value => value.step === object.step)!;
        assert.ok(['original', 'preserved', 'restored'].includes(row.state), 'global_recovery_chain_original_state_invalid');
        object.state = row.state as typeof object.state; object.rows = structuredClone(row.original.rows); object.stateSha256 = shaGlobalRecoveryValue(object.rows);
        object.working = structuredClone(row.working);
      }
      const generated = model.generated.map((row, index) => ({ name: row.name, backupName: row.name === 'shell' ? 'generated-shell' : 'generated-' + index,
        status: row.status as 'absent' | 'installed' | 'quarantined', rows: row.entry ? structuredClone(row.entry.rows) : null }));
      const shell: NonNullable<GlobalRecoverySnapshot['shell']> = { schema: 'caveat.global_shell_objects.v1', files: generated.slice(0, -1), manifest: generated.at(-1)! };
      return await use({ plan, original, shell, guard, bindings, evidenceSha256: shaGlobalRecoveryValue(admission), journalSha256: chain.journalSha256,
        verifyEvidence: chain.verifyEvidence, verifyProtected: protectedState.verify, admission, sourceRoots: chain.roots, vacancySlots: slots });
    } finally { guard.close(); }
  });
}

export async function checkGlobalRecoveryProcesses(source: GlobalRecoverySnapshot, runDirectory: string, target: string,
  emit: (event: ProcessProbeEvent) => void, collect: typeof nativeGlobalProcessTables) {
  const { plan } = source;
  const scope = { packageRoot: join(plan.globalRoot, 'caveat-cli'), npmRoot: dirname(dirname(plan.baseline.npm.executable)), runtimeExecutables: [plan.nodeProof.executable.canonical],
    binAliases: plan.leaves.map(row => join(plan.binDirectory, row.name)), protectedPaths: [...new Set([...(source.sourceRoots ?? [runDirectory]), target, ...plan.protectedObjects.map(row => row.path), ...plan.aliases.map(row => row.path), ...plan.absences.map(row => row.path)])] };
  const result = await preflightGlobalProcesses(scope, emit, collect);
  if (result.status !== 'ready') throw Object.assign(Error('global_recovery_process_preflight_stopped'), { preflight: result, readOnlyCheckFailed: true });
  return result;
}

/** Read-only fresh plan; it creates neither a lock nor a private recovery directory. */
export function planGlobalRecovery(runDirectory: string, planSha256: string, emit: (event: ProcessProbeEvent) => void = () => {}) {
  return planGlobalRecoveryWithCollector(runDirectory, planSha256, nativeGlobalProcessTables, emit);
}
export async function planGlobalRecoveryWithCollector(runDirectory: string, planSha256: string, collect: typeof nativeGlobalProcessTables, emit: (event: ProcessProbeEvent) => void = () => {}) {
  try {
    assert.match(planSha256, /^[a-f0-9]{64}$/);
    const result = await withGlobalRecoverySourceSnapshot(runDirectory, planSha256, async source => {
      const target = join(source.plan.root, 'global-recovery-' + source.evidenceSha256.slice(0, 32));
      const verify = () => { source.verifyEvidence(); source.verifyProtected(); source.guard.assertCurrent();
        for (const row of source.bindings.values()) {
          if (row.tree) assert.deepEqual(source.guard.readTree(row.tree), row.rows);
          else assert.equal(source.guard.observe(row.directory, row.name), null, 'global_recovery_plan_vacancy_changed');
        }
        const occupied = new Set([...source.bindings.values()].filter(row => row.tree).map(row => join(row.directory, row.name)));
        for (const row of source.vacancySlots ?? []) if (!occupied.has(join(row.directory, row.name))) assert.equal(source.guard.observe(row.directory, row.name), null);
        assert.equal(source.guard.observe(source.plan.root, 'installer.lock'), null, 'global_recovery_installer_busy');
        assert.equal(source.guard.observe(source.plan.root, basename(target)), null, 'global_recovery_attempt_already_exists');
      };
      verify();
      const processAssessment = await checkGlobalRecoveryProcesses(source, runDirectory, target, emit, collect); verify();
      return { schema: 'caveat.global_recovery_plan.v1' as const, status: 'ready' as const, planSha256, evidenceSha256: source.evidenceSha256,
        processAssessment, currentObjects: 'confirmed' as const, executionPermission: false as const, filesystemWrites: 0, existingProcessOperations: 0 };
    });
    assert.equal(result.schema, 'caveat.global_recovery_plan.v1', 'global_recovery_plan_source_unconfirmed'); return result;
  } catch (error) { return { schema: 'caveat.global_recovery_plan.v1' as const, status: 'stopped' as const,
    processAssessment: (error as { preflight?: unknown })?.preflight ?? null,
    errorSha256: shaGlobalRecoveryValue(error instanceof Error ? error.name + ':' + error.message : String(error)),
    currentObjects: 'not-confirmed' as const, executionPermission: false as const, filesystemWrites: 0, existingProcessOperations: 0 }; }
}
