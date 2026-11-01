import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { bindGlobalAdmission, type GlobalMigrationInput } from './managedGlobalMigration.js';
import { globalProcessResidualRisks } from './managedGlobalProcesses.js';
import { nativeGlobalProcessTables, type ProcessProbeEvent } from './managedProcessNative.js';
import { inspectGlobalMigrationRecovery } from './managedGlobalRecovery.js';
import { managedShellStatusCurrent } from './managedGlobalShellStatus.js';

export type GlobalMigrationEvent = { schema: 'caveat.global_migration_event.v1'; sequence: number; phase: string; event: string; planSha256: string | null; runId: string | null; pid?: number };
type Admission = Awaited<ReturnType<typeof bindGlobalAdmission>>;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Public execution always uses the product native collector and fixed npm command. */
export function executeGlobalMigration(input: GlobalMigrationInput, expectedPlanSha256: string, emit: (event: GlobalMigrationEvent) => void) {
  return coordinateGlobalMigration(input, expectedPlanSha256, emit, (value, events) => bindGlobalAdmission(value, events, nativeGlobalProcessTables));
}

/** Admission injection belongs to isolated fixtures, never to CLI arguments or environment. */
export async function coordinateGlobalMigration(input: GlobalMigrationInput, expectedPlanSha256: string, emit: (event: GlobalMigrationEvent) => void,
  admit: (input: GlobalMigrationInput, events: (event: ProcessProbeEvent) => void) => Promise<Admission>) {
  let sequence = 0, phase = 'admission', planSha256: string | null = null, runId: string | null = null, admission: Admission | null = null;
  let processAssessment: ReturnType<Admission['processAssessment']> = null;
  let configState: Admission['configState'] | undefined;
  let failedConfigObservations: ReturnType<Admission['configState']['records']> = [];
  let mutationStarted = false;
  let result: { status: 'completed' | 'stopped' | 'unknown'; phase: string; errorSha256?: string; reason?: string; diagnostic?: unknown; sharingViolation?: { code: number; file?: string; instruction: string; readableHolders: unknown[] } } = { status: 'unknown', phase };
  const event = (kind: string, pid?: number) => emit({ schema: 'caveat.global_migration_event.v1', sequence: ++sequence, phase, event: kind, planSha256, runId, ...(pid ? { pid } : {}) });
  try {
    event('issued'); assert.ok(/^[a-f0-9]{64}$/.test(expectedPlanSha256), 'global_migration_expected_hash_required');
    admission = await admit(input, probe => { const saved = phase; phase = 'process-preflight'; try { event(probe.event, probe.pid); } finally { phase = saved; } });
    configState = admission.configState;
    planSha256 = admission.planSha256;
    assert.equal(planSha256, expectedPlanSha256, 'global_migration_expected_plan_changed'); event('completed');
    const reviewed = admission.plan, node = reviewed.baseline.node;
    const pointerSha256 = reviewed.protectedObjects.find(row => row.path === join(reviewed.root, 'active.json'))?.rows[0]?.identity.contentSha256;
    assert.ok(pointerSha256, 'global_migration_reviewed_pointer_required');
    phase = 'prepare'; event('issued');
    mutationStarted = true;
    const session = await admission.prepare(expectedPlanSha256); runId = basename(session.runDirectory); event('completed');
    for (const [step, run, expected] of [
      ['preserve', () => session.engine.preserveAll(), 'preserved'],
      ['working-copy', () => session.engine.createWorkingCopies(), 'working'],
      ['npm-uninstall', () => session.uninstall(value => event(value.event, value.pid ?? undefined)), 'removed'],
      ['wrappers', () => session.shell.install(), 'installed'],
    ] as const) {
      phase = step; event('issued'); const observed = await run();
      if (observed.status !== expected) {
        const failure = ('result' in observed ? observed.result : null) as { nativeCode?: number; file?: string } | null;
        result = failure?.nativeCode === 32 ? { status: 'stopped', phase, sharingViolation: { code: 32, file: failure.file, instruction: 'Close the AI client using this file, then retry.', readableHolders: admission.processAssessment()?.records ?? [] } }
          : { status: observed.status === 'unknown' ? 'unknown' : 'stopped', phase,
            ...('errorSha256' in observed ? { errorSha256: observed.errorSha256 } : {}),
            ...('reason' in observed ? { reason: observed.reason } : {}),
            ...('diagnostic' in observed ? { diagnostic: observed.diagnostic } : {}),
            ...('shell' in observed ? { shell: { ...observed.shell, ...('recovery' in observed ? { recovery: observed.recovery } : {}) } } : {}) }; event(result.status); return await finish();
      }
      event('completed');
    }
    phase = 'checkpoint'; event('issued'); await session.engine.verifyCurrent();
    assert.equal(session.shell.status().status, 'ready', 'global_migration_shell_unconfirmed');
    // A complete mutation journal is a state checkpoint, not proof of later close or independent readback.
    session.journal.complete(sha({ planSha256, originals: session.engine.manifest(), shell: session.shell.snapshot() }));
    const journalSha256 = session.journal.read().bytesSha256; event('completed');
    processAssessment = admission.processAssessment();
    phase = 'close'; event('issued'); admission.close(); admission = null; event('completed');
    phase = 'readback'; event('issued');
    const persisted = await inspectGlobalMigrationRecovery(session.runDirectory, planSha256);
    assert.ok(persisted.status === 'observed' && persisted.reason === 'recorded_state_matches' && persisted.journalStatus === 'complete', 'global_migration_persisted_readback_unconfirmed');
    assert.equal(persisted.journalSha256, journalSha256, 'global_migration_readback_journal_changed'); event('persisted-verified');
    const readback = await managedShellStatusCurrent({ root: reviewed.root });
    assert.ok(readback.status === 'ready' && 'native' in readback, 'global_migration_independent_readback_unconfirmed');
    assert.equal(readback.deployment?.pointerSha256, pointerSha256, 'global_migration_readback_pointer_changed');
    assert.equal(readback.nodeSha256, sha({ command: 'node', version: node.version }), 'global_migration_readback_node_changed');
    assert.deepEqual(readback.wrappers, reviewed.shellPlan.files.map(({ path, sha256 }) => ({ path, sha256 })), 'global_migration_readback_wrappers_changed'); event('completed');
    result = { status: 'completed', phase };
  } catch (error) {
    processAssessment = (error as { preflight?: typeof processAssessment }).preflight ?? processAssessment;
    failedConfigObservations = (error as { configObservations?: typeof failedConfigObservations }).configObservations ?? [];
    result = { status: phase === 'admission' ? 'stopped' : 'unknown', phase, reason: error instanceof Error ? error.message : String(error), diagnostic: (error as { diagnostic?: unknown }).diagnostic ?? null, errorSha256: sha(error instanceof Error ? error.name + ':' + error.message : String(error)) };
  }
  return await finish();

  async function finish() {
    if (admission) {
      processAssessment = admission.processAssessment();
      try { admission.close(); } catch (error) { result = { status: 'unknown', phase: 'close', errorSha256: sha(error instanceof Error ? error.name + ':' + error.message : String(error)) }; }
      admission = null;
    }
    configState?.observe();
    phase = 'terminal';
    try { event(result.status); } catch { result = { status: 'unknown', phase: 'receipt' }; }
    return { schema: 'caveat.global_migration_result.v1' as const, ...result, configObservations: configState?.records() ?? failedConfigObservations, planSha256, runId, processAssessment, residualRisks: globalProcessResidualRisks, filesystemWrites: mutationStarted ? null : 0,
      recovery: mutationStarted && result.status !== 'completed' ? { command: 'deployment global-recovery-plan', runId, planSha256, requiresFreshEvidence: true } : null, existingProcessOperations: 0, privilegeElevation: false as const };
  }
}
