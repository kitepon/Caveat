import assert from 'node:assert/strict';
import { join } from 'node:path';
import { globalRecoveryKeys, globalRecoveryRows, shaGlobalRecoveryValue, type GlobalMigrationEvidence } from './managedGlobalRecovery.js';
import { assertGlobalRestoreOrder } from './managedGlobalPreservation.js';
import type { GlobalGuardTreeRow } from './managedGlobalGuard.js';
import type { GlobalJournalOperation } from './managedGlobalJournal.js';

export type RecoveryLocation = { directory: string; name: string; rows: GlobalGuardTreeRow[] };
export type RecoveryModel = { schema: 'caveat.global_recovery_objects.v1'; sourceEvidenceSha256: string; confirmed: true;
  objects: { step: string; role: string; state: string; original: RecoveryLocation; working: GlobalMigrationEvidence['original']['objects'][number]['working']; workingEntry: RecoveryLocation | null }[];
  generated: { name: string; status: string; entry: RecoveryLocation | null }[] };
export type RecoveryRecord = { schema: string; sourceEvidenceSha256: string; step: string; operation: GlobalJournalOperation; state: RecoveryModel;
  renameAttempted: boolean; renameIssued: boolean | null; result?: unknown };

/** This projection uses only validated migration roles and their fixed names, never a saved recovery path. */
export function recoveryModelFromMigration(source: GlobalMigrationEvidence, root: string): RecoveryModel {
  const location = (directory: string, name: string, rows: GlobalGuardTreeRow[]) => ({ directory, name, rows: structuredClone(rows) });
  return { schema: 'caveat.global_recovery_objects.v1', sourceEvidenceSha256: source.evidenceSha256, confirmed: true,
    objects: source.original.objects.map(object => {
      assert.ok(object.state !== 'unknown' && (!object.working || !['unknown', 'released'].includes(object.working.status)), 'global_recovery_model_unknown');
      assert.ok(object.state === 'preserved' || !object.working || ['absent', 'quarantined'].includes(object.working.status), 'global_recovery_model_conflicting_working');
      return { step: object.step, role: object.role, state: object.state,
        original: location(object.state === 'preserved' ? root : object.directory, object.state === 'preserved' ? object.backupName : object.name, object.rows),
        working: structuredClone(object.working), workingEntry: !object.working || object.working.status === 'absent' ? null
          : location(object.working.status === 'quarantined' ? root : object.directory, object.working.status === 'quarantined' ? 'used-' + object.working.stagingName : object.name, object.working.rows!) };
    }),
    generated: (source.shell ? [...source.shell.files, source.shell.manifest] : [...source.plan.leaves.map(row => ({ name: row.name, status: 'absent', rows: null, backupName: '' })), { name: 'shell', status: 'absent', rows: null, backupName: '' }])
      .map(row => ({ name: row.name, status: row.status, entry: row.status === 'absent' ? null
        : location(row.status === 'quarantined' ? root : row.name === 'shell' ? source.plan.root : source.plan.binDirectory, row.status === 'quarantined' ? 'used-' + row.backupName : row.name, row.rows!) })) };
}

function nextAction(model: RecoveryModel, origin: GlobalMigrationEvidence, target: string) {
  for (const index of [model.generated.length - 1, ...model.generated.slice(0, -1).map((_, i) => i)]) {
    const row = model.generated[index]!;
    if (row.status === 'installed') return { step: 'retire.generated.' + row.name, operation: row.name === 'shell' ? 'manifest' as const : 'wrapper' as const,
      entry: row.entry!, directory: target, name: 'used-' + (row.name === 'shell' ? 'generated-shell' : 'generated-' + index), update() { row.status = 'quarantined'; } };
  }
  for (const row of model.objects) if (row.working?.status === 'known' || row.working?.status === 'after-known') return {
    step: 'retire.working.' + row.step, operation: 'working-copy' as const, entry: row.workingEntry!, directory: target, name: 'used-working-' + row.step,
    update() { row.working!.status = 'quarantined'; row.working!.rows = structuredClone(row.workingEntry!.rows); },
  };
  for (const role of ['package', 'npm-management', 'leaf']) for (const row of model.objects) if (row.role === role && row.state === 'preserved') {
    assertGlobalRestoreOrder(model.objects, role); const spec = origin.original.objects.find(value => value.step === row.step)!;
    return { step: 'restore.' + row.step, operation: 'restore' as const, entry: row.original, directory: spec.directory, name: spec.name, update() { row.state = 'restored'; } };
  }
  assert.ok(model.objects.every(row => ['original', 'restored'].includes(row.state)), 'global_recovery_model_not_terminal'); return null;
}

/** Replay is validation of recorded data only. It never issues a syscall or adopts the record's paths. */
export function applyConfirmedRecoveryRecord(model: RecoveryModel, record: RecoveryRecord, origin: GlobalMigrationEvidence, target: string) {
  globalRecoveryKeys(record, ['schema', 'sourceEvidenceSha256', 'step', 'operation', 'state', 'renameAttempted', 'renameIssued', 'result']);
  assert.ok(record.schema === 'caveat.global_recovery_state.v1' && record.sourceEvidenceSha256 === model.sourceEvidenceSha256
    && record.renameAttempted === true && record.renameIssued === true, 'global_recovery_record_unconfirmed');
  const action = nextAction(model, origin, target); assert.ok(action && record.step === action.step && record.operation === action.operation, 'global_recovery_transition_out_of_scope');
  const result = record.result as { status: string; renameIssued: boolean; automaticRecovery: boolean; before: GlobalGuardTreeRow['identity']; after: GlobalGuardTreeRow['identity']; treeBefore: GlobalGuardTreeRow[]; treeAfter: GlobalGuardTreeRow[] };
  globalRecoveryKeys(result, ['status', 'renameIssued', 'automaticRecovery', 'before', 'after', 'treeBefore', 'treeAfter']);
  assert.ok(result.status === 'moved' && result.renameIssued === true && result.automaticRecovery === false, 'global_recovery_move_result_unknown');
  globalRecoveryRows(result.treeBefore); globalRecoveryRows(result.treeAfter);
  assert.deepEqual(result.treeBefore, action.entry.rows, 'global_recovery_move_source_changed');
  assert.deepEqual(result.before, action.entry.rows[0]!.identity, 'global_recovery_move_before_changed');
  const expected = structuredClone(action.entry.rows); expected[0]!.identity.ctime = result.treeAfter[0]!.identity.ctime;
  assert.deepEqual(result.treeAfter, expected, 'global_recovery_move_identity_changed'); assert.deepEqual(result.after, result.treeAfter[0]!.identity, 'global_recovery_move_after_changed');
  action.entry.directory = action.directory; action.entry.name = action.name; action.entry.rows = structuredClone(result.treeAfter); action.update();
  assert.deepEqual(record.state, model, 'global_recovery_record_paths_or_state_changed');
}

export function validateRecoveryJournalState(model: RecoveryModel, journal: { records: { kind: string; stateSha256: string | null; sequence: number }[] },
  states: Map<number, RecoveryRecord>, origin: GlobalMigrationEvidence, target: string) {
  for (const row of journal.records) {
    if (row.kind === 'intent') assert.equal(row.stateSha256, shaGlobalRecoveryValue(model), 'global_recovery_intent_state_changed');
    else if (row.kind === 'result') { const state = states.get(row.sequence); assert.ok(state, 'global_recovery_record_required'); applyConfirmedRecoveryRecord(model, state, origin, target); }
    else { assert.equal(nextAction(model, origin, target), null, 'global_recovery_completion_is_partial'); assert.equal(row.stateSha256, shaGlobalRecoveryValue(model), 'global_recovery_checkpoint_changed'); }
  }
}

export function recoveryLocations(model: RecoveryModel) {
  return [...model.objects.flatMap(row => [row.original, ...(row.workingEntry ? [row.workingEntry] : [])]), ...model.generated.flatMap(row => row.entry ? [row.entry] : [])];
}

export function recoveryVacancySlots(origin: GlobalMigrationEvidence, roots: string[]) {
  const slots = new Map<string, { directory: string; name: string }>(), slot = (directory: string, name: string) => slots.set(join(directory, name), { directory, name });
  for (const row of origin.original.objects) {
    slot(row.directory, row.name); slot(row.backupDirectory, row.backupName);
    if (row.working) slot(row.backupDirectory, 'used-' + row.working.stagingName);
    for (const root of roots) slot(root, 'used-working-' + row.step);
  }
  for (const leaf of origin.plan.leaves) slot(origin.plan.binDirectory, leaf.name);
  slot(origin.plan.root, 'shell'); if (origin.plan.baseline.npmManagement.absent) slot(origin.plan.globalRoot, '.package-lock.json');
  for (const root of roots) for (const [index] of origin.plan.leaves.entries()) slot(root, 'used-generated-' + index);
  for (const root of roots) slot(root, 'used-generated-shell');
  return [...slots.values()];
}
