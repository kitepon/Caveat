import assert from 'node:assert/strict';
import { recoveryPathContains, type GlobalRecoveryConfigState } from './managedGlobalRecoveryConfig.js';
import { createHash } from 'node:crypto';
import { basename, join, dirname } from 'node:path';
import { bindGlobalRecoveryProtected, globalRecoveryGuardPaths } from './managedGlobalRecovery.js';
import { openGlobalPathGuard, type GlobalGuardTree, type GlobalGuardTreeRow } from './managedGlobalGuard.js';
import { createGlobalMutationJournal, type GlobalJournalOperation } from './managedGlobalJournal.js';
import { assertGlobalRestoreOrder, writeGlobalPrivateEvidence } from './managedGlobalPreservation.js';
import { checkGlobalRecoveryProcesses, withGlobalRecoverySourceSnapshot } from './managedGlobalRecoveryChain.js';
import { nativeGlobalProcessTables, type ProcessProbeEvent } from './managedProcessNative.js';

type Entry = { directory: string; name: string; rows: GlobalGuardTreeRow[]; tree: GlobalGuardTree };
export type GlobalRecoveryEvent = { schema: 'caveat.global_recovery_event.v1'; sequence: number; phase: string; event: string;
  planSha256: string | null; evidenceSha256: string | null; runId: string | null; pid?: number };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorSha = (value: unknown) => sha(value instanceof Error ? value.name + ':' + value.message : String(value));

/** No command, collector or permission override is accepted by the production entry. */
export function executeGlobalRecovery(runDirectory: string, planSha256: string, evidenceSha256: string, emit: (event: GlobalRecoveryEvent) => void = () => {}) {
  return recoverGlobalMigration(runDirectory, planSha256, evidenceSha256, emit, nativeGlobalProcessTables);
}

/** The injected collector is confined to source fixtures, never CLI arguments or environment. */
export async function recoverGlobalMigration(runDirectory: string, planSha256: string, evidenceSha256: string,
  emit: (event: GlobalRecoveryEvent) => void, collect: typeof nativeGlobalProcessTables) {
  let processAssessment: Awaited<ReturnType<typeof checkGlobalRecoveryProcesses>> | null = null;
  let configState: GlobalRecoveryConfigState | undefined;
  let sequence = 0, phase = 'admission', recoveryDirectory: string | null = null, writes = false;
  const event = (kind: string, pid?: number) => emit({ schema: 'caveat.global_recovery_event.v1', sequence: ++sequence, phase, event: kind,
    planSha256: /^[a-f0-9]{64}$/.test(planSha256) ? planSha256 : null, evidenceSha256: /^[a-f0-9]{64}$/.test(evidenceSha256) ? evidenceSha256 : null,
    runId: recoveryDirectory ? basename(recoveryDirectory) : null, ...(pid ? { pid } : {}) });
  try {
    event('issued'); assert.ok(/^[a-f0-9]{64}$/.test(planSha256) && /^[a-f0-9]{64}$/.test(evidenceSha256), 'global_recovery_expected_digests_required');
    const result = await withGlobalRecoverySourceSnapshot(runDirectory, planSha256, async source => {
      assert.equal(source.evidenceSha256, evidenceSha256, 'global_recovery_expected_evidence_changed');
      configState = source.configState;
      const { plan, guard } = source, target = join(plan.root, 'global-recovery-' + evidenceSha256.slice(0, 32));
      const entry = (key: string): Entry => {
        const binding = source.bindings.get(key); assert.ok(binding?.tree && binding.rows, 'global_recovery_known_object_required');
        return { ...binding, tree: binding.tree, rows: structuredClone(binding.rows) };
      };
      const objects = source.original.objects.map(value => {
        const object = structuredClone(value); assert.ok(object.state !== 'unknown', 'global_recovery_original_unknown');
        assert.ok(!object.working || ['known', 'after-known', 'absent', 'quarantined'].includes(object.working.status), 'global_recovery_working_unknown');
        assert.ok(object.state === 'preserved' || !object.working || ['absent', 'quarantined'].includes(object.working.status), 'global_recovery_conflicting_working_state');
        return { ...object, original: entry('original.' + object.step), workingEntry: !object.working || object.working.status === 'absent' ? null
          : entry((object.working.status === 'quarantined' ? 'quarantined.' : 'working.') + object.step) };
      });
      const generated = (source.shell ? [...source.shell.files, source.shell.manifest] : [
        ...plan.leaves.map((leaf, index) => ({ name: leaf.name, backupName: 'generated-' + index, status: 'absent' as const, rows: null })),
        { name: 'shell', backupName: 'generated-shell', status: 'absent' as const, rows: null },
      ]).map(row => ({ ...structuredClone(row), entry: row.status === 'absent' ? null : entry('generated.' + row.name) }));
      const slots = new Map<string, { directory: string; name: string }>();
      const slot = (directory: string, name: string) => slots.set(join(directory, name), { directory, name });
      for (const object of objects) {
        slot(object.directory, object.name); slot(object.backupDirectory, object.backupName);
        if (object.working) slot(runDirectory, 'used-' + object.working.stagingName);
      }
      for (const leaf of plan.leaves) slot(plan.binDirectory, leaf.name);
      slot(plan.root, 'shell'); if (plan.baseline.npmManagement.absent) slot(plan.globalRoot, '.package-lock.json');
      for (const row of generated) slot(runDirectory, 'used-' + row.backupName);
      for (const row of source.vacancySlots ?? []) slot(row.directory, row.name);
      const entries = () => [...objects.flatMap(row => [row.original, ...(row.workingEntry ? [row.workingEntry] : [])]), ...generated.flatMap(row => row.entry ? [row.entry] : [])];
      const protectedPaths = [...plan.protectedObjects.map(row => join(guard.canonicalDirectory(dirname(row.path)), basename(row.path))),
        ...(source.protection?.otherGlobals.packages ?? []).map(row => join(guard.canonicalDirectory(plan.globalRoot), row.name))];
      const verifyMutationScope = (currentEntries: Pick<Entry, 'rows'>[] = entries(), canonical = (directory: string) => guard.canonicalDirectory(directory)) => {
        const paths = [...protectedPaths, ...(configState?.paths() ?? [])];
        for (const place of [...slots.values(), { directory: plan.root, name: basename(target) }, { directory: plan.root, name: 'installer.lock' }]) {
          const path = join(canonical(place.directory), place.name);
          assert.ok(paths.every(protectedPath => !recoveryPathContains(path, protectedPath) && !recoveryPathContains(protectedPath, path)), 'global_recovery_protected_mutation_scope');
        }
        const identities = [...(source.protection?.objects.flatMap(row => row.rows.map(value => value.identity)) ?? []), ...(configState?.identities() ?? [])];
        const protectedIdentities = new Set(identities.map(row => row.dev + ':' + row.ino));
        for (const entry of currentEntries) assert.ok(entry.rows.every(row => !protectedIdentities.has(row.identity.dev + ':' + row.identity.ino)), 'global_recovery_protected_mutation_identity');
      };
      const verifyObjects = () => {
        const occupied = new Set<string>();
        for (const known of entries()) {
          const path = join(known.directory, known.name); assert.ok(!occupied.has(path), 'global_recovery_overlapping_object'); occupied.add(path);
          assert.deepEqual(guard.readTree(known.tree), known.rows, 'global_recovery_current_object_changed');
        }
        for (const [path, place] of slots) if (!occupied.has(path)) assert.equal(guard.observe(place.directory, place.name), null, 'global_recovery_unknown_name_appeared');
      };
      let currentJournal: ReturnType<typeof createGlobalMutationJournal> | undefined;
      const processCheck = async () => {
        processAssessment = await checkGlobalRecoveryProcesses(source, runDirectory, target, (probe: ProcessProbeEvent) => {
          const saved = phase; phase = 'process-preflight'; try { event(probe.event, probe.pid); } finally { phase = saved; }
        }, collect);
      };
      const verifyImmutable = () => { source.verifyEvidence(); source.verifyProtected(); verifyObjects(); verifyMutationScope(); };
      const verifyCurrent = async () => { verifyImmutable(); await processCheck(); verifyImmutable(); };
      await verifyCurrent();
      assert.equal(guard.observe(plan.root, 'installer.lock'), null, 'global_recovery_installer_busy');
      assert.equal(guard.observe(plan.root, basename(target)), null, 'global_recovery_attempt_already_exists');
      phase = 'private-run'; event('issued'); writes = true; recoveryDirectory = target;
      guard.createPrivateDirectory(plan.root, basename(target));
      const references: ReturnType<typeof writeGlobalPrivateEvidence>[] = [];
      references.push(writeGlobalPrivateEvidence(guard, target, 'source.json', { schema: 'caveat.global_recovery_source.v2', admission: source.admission ?? null, sourceRun: basename(runDirectory), planSha256,
        evidenceSha256, journalSha256: source.journalSha256 }));
      const lock = guard.createJournal(target, 'installer-lock.json', Buffer.from(JSON.stringify({ schema: 1, pid: process.pid, startedAt: new Date().toISOString() }) + '\n'));
      const acquired = guard.moveJournalNoReplace(lock, plan.root, 'installer.lock'); assert.equal(acquired.status, 'moved', 'global_recovery_lock_acquire_unknown');
      let lockAtRoot = true, poisoned = false;
      try {
        const journal = currentJournal = createGlobalMutationJournal(guard, target, 'journal.jsonl', planSha256);
        const snapshot = () => ({ schema: 'caveat.global_recovery_objects.v1', sourceEvidenceSha256: evidenceSha256, confirmed: !poisoned,
          objects: objects.map(({ step, role, state, original, working, workingEntry }) => ({ step, role, state, original: withoutToken(original), working,
            workingEntry: workingEntry ? withoutToken(workingEntry) : null })), generated: generated.map(({ name, status, entry }) => ({ name, status, entry: entry ? withoutToken(entry) : null })) });
        const verify = async () => { assert.ok(!poisoned, 'global_recovery_attempt_poisoned'); await verifyCurrent(); guard.readJournal(lock);
          for (const ref of references) assert.equal(createHash('sha256').update(guard.readPersistedJournal(target, ref.name)).digest('hex'), ref.sha256, 'global_recovery_new_evidence_changed'); };
        const move = async (known: Entry, directory: string, name: string, step: string, operation: GlobalJournalOperation, update: () => void) => {
          assert.ok(!poisoned, 'global_recovery_attempt_poisoned'); verifyImmutable(); guard.readJournal(lock);
          for (const ref of references) assert.equal(createHash('sha256').update(guard.readPersistedJournal(target, ref.name)).digest('hex'), ref.sha256, 'global_recovery_new_evidence_changed');
          slot(directory, name);
          journal.intent(step, operation, sha(snapshot())); event('intent-persisted');
          let result: ReturnType<typeof guard.moveTreeNoReplace> | undefined, failure: string | undefined, renameAttempted = false;
          try {
            // Reobserve the last confirmed native locations; the pending destination grants no authority.
            await processCheck();
            verifyImmutable(); guard.readJournal(lock); renameAttempted = true;
            result = guard.moveTreeNoReplace(known.tree, directory, name); assert.equal(result.status, 'moved', 'global_recovery_move_unconfirmed');
            known.directory = directory; known.name = name; known.rows = guard.readTree(known.tree); update(); verifyObjects();
          } catch (error) { poisoned = true; failure = errorSha(error); }
          const reference = writeGlobalPrivateEvidence(guard, target, 'state-' + journal.read().header.runId + '-' + journal.read().nextSequence + '.json', {
            schema: 'caveat.global_recovery_state.v1', sourceEvidenceSha256: evidenceSha256, step, operation, state: snapshot(), renameAttempted, renameIssued: result?.renameIssued ?? (renameAttempted ? null : false), result, errorSha256: failure,
          }); references.push(reference);
          journal.result(step, operation, poisoned ? 'unknown' : 'confirmed', reference.sha256); event(poisoned ? 'unknown' : 'completed');
          assert.ok(!poisoned, 'global_recovery_move_unknown');
          await verify();
        };
        phase = 'quarantine-generated';
        for (const row of [generated[generated.length - 1]!, ...generated.slice(0, -1)]) if (row.status === 'installed') {
          await move(row.entry!, target, 'used-' + row.backupName, 'retire.generated.' + row.name, row.name === 'shell' ? 'manifest' : 'wrapper', () => { row.status = 'quarantined'; });
        }
        phase = 'quarantine-working';
        for (const row of objects) if (row.working?.status === 'known' || row.working?.status === 'after-known') {
          await move(row.workingEntry!, target, 'used-working-' + row.step, 'retire.working.' + row.step, 'working-copy', () => { row.working!.status = 'quarantined'; row.working!.rows = structuredClone(row.workingEntry!.rows); });
        }
        for (const role of ['package', 'npm-management', 'leaf']) for (const row of objects.filter(value => value.role === role)) if (row.state === 'preserved') {
          phase = 'restore-' + role; assertGlobalRestoreOrder(objects, role);
          await move(row.original, row.directory, row.name, 'restore.' + row.step, 'restore', () => { row.state = 'restored'; });
        }
        phase = 'checkpoint'; await verify();
        assert.ok(objects.every(row => row.state === 'original' || row.state === 'restored'), 'global_recovery_originals_not_restored');
        journal.complete(sha(snapshot())); const journalSha256 = journal.read().bytesSha256;
        const finalEntries = entries().map(withoutToken); event('completed'); phase = 'close';
        const archived = guard.moveJournalNoReplace(lock, target, 'installer-lock.json'); assert.equal(archived.status, 'moved', 'global_recovery_lock_archive_unknown'); lockAtRoot = false;
        const directoryBindings = guard.directoryBindings();
        guard.close(); event('completed'); phase = 'readback'; event('issued');
        const reader = await openGlobalPathGuard([...globalRecoveryGuardPaths(plan, runDirectory), ...(source.sourceRoots ?? []), target]);
        try {
          const directories = reader.directoryBindings();
          for (const binding of directoryBindings) assert.deepEqual(directories.find(row => row.path === binding.path), binding, 'global_recovery_readback_directory_changed');
          const protectedState = bindGlobalRecoveryProtected(plan, reader, source.protection, configState); protectedState.verify(); source.verifyEvidence();
          const held = finalEntries.map(known => ({ known, tree: reader.retainTree(known.directory, known.name) }));
          const occupied = new Set(finalEntries.map(row => join(row.directory, row.name)));
          for (const [path, place] of slots) if (!occupied.has(path)) assert.equal(reader.observe(place.directory, place.name), null, 'global_recovery_readback_unknown_name');
          for (const row of held) assert.deepEqual(reader.readTree(row.tree), row.known.rows, 'global_recovery_readback_object_changed');
          assert.equal(createHash('sha256').update(reader.readPersistedJournal(target, 'journal.jsonl')).digest('hex'), journalSha256, 'global_recovery_readback_journal_changed');
          for (const ref of references) assert.equal(createHash('sha256').update(reader.readPersistedJournal(target, ref.name)).digest('hex'), ref.sha256, 'global_recovery_readback_evidence_changed');
          protectedState.verify(); source.verifyEvidence(); verifyMutationScope(finalEntries, directory => reader.canonicalDirectory(directory));
        } finally { reader.close(); }
        event('completed'); return { status: 'restored' as const, phase, journalSha256 };
      } finally {
        if (lockAtRoot) { const archived = guard.moveJournalNoReplace(lock, target, 'installer-lock.json'); assert.equal(archived.status, 'moved', 'global_recovery_lock_archive_unknown'); }
      }
    });
    const outcome = 'executionPermission' in result ? { status: 'stopped' as const, phase, reason: result.reason } : result;
    phase = 'terminal'; event(outcome.status);
    return { schema: 'caveat.global_recovery_result.v1' as const, ...outcome, runId: recoveryDirectory ? basename(recoveryDirectory) : null,
      processAssessment, configObservations: configState?.records() ?? [], filesystemWrites: writes ? null : 0, existingProcessOperations: 0, privilegeElevation: false as const };
  } catch (error) {
    processAssessment = (error as { preflight?: typeof processAssessment })?.preflight ?? processAssessment;
    const result = { schema: 'caveat.global_recovery_result.v1' as const, status: writes ? 'unknown' as const : 'stopped' as const, phase, errorSha256: errorSha(error),
      runId: recoveryDirectory ? basename(recoveryDirectory) : null,
      recovery: writes ? { command: 'deployment global-recovery-plan', runId: recoveryDirectory ? basename(recoveryDirectory) : null, planSha256, requiresFreshEvidence: true } : null, processAssessment, configObservations: configState?.records() ?? [], filesystemWrites: writes ? null : 0, existingProcessOperations: 0, privilegeElevation: false as const };
    phase = 'terminal'; try { event(result.status); } catch { /* The failed receipt cannot authorize replay. */ } return result;
  }
}

const withoutToken = ({ directory, name, rows }: Entry) => ({ directory, name, rows: structuredClone(rows) });

export { inspectGlobalRecoveryAttempt } from './managedGlobalRecoveryAttempt.js';
