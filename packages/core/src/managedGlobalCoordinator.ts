import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { bindGlobalAdmission, type GlobalMigrationInput } from './managedGlobalMigration.js';
import { nativeGlobalProcessTables, type ProcessProbeEvent } from './managedProcessNative.js';
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
  let result: { status: 'completed' | 'stopped' | 'unknown'; phase: string; errorSha256?: string } = { status: 'unknown', phase };
  const event = (kind: string, pid?: number) => emit({ schema: 'caveat.global_migration_event.v1', sequence: ++sequence, phase, event: kind, planSha256, runId, ...(pid ? { pid } : {}) });
  try {
    event('issued'); assert.ok(/^[a-f0-9]{64}$/.test(expectedPlanSha256), 'global_migration_expected_hash_required');
    admission = await admit(input, probe => { const saved = phase; phase = 'process-preflight'; try { event(probe.event, probe.pid); } finally { phase = saved; } });
    planSha256 = admission.planSha256;
    assert.equal(planSha256, expectedPlanSha256, 'global_migration_expected_plan_changed'); event('completed');
    phase = 'prepare'; event('issued');
    const session = await admission.prepare(expectedPlanSha256); runId = basename(session.runDirectory); event('completed');
    for (const [step, run, expected] of [
      ['preserve', () => session.engine.preserveAll(), 'preserved'],
      ['working-copy', () => session.engine.createWorkingCopies(), 'working'],
      ['npm-uninstall', () => session.uninstall(value => event(value.event, value.pid ?? undefined)), 'removed'],
      ['wrappers', () => session.shell.install(), 'installed'],
    ] as const) {
      phase = step; event('issued'); const observed = await run();
      if (observed.status !== expected) {
        result = { status: observed.status === 'unknown' ? 'unknown' : 'stopped', phase }; event(result.status); return await finish();
      }
      event('completed');
    }
    phase = 'checkpoint'; event('issued'); await session.engine.verifyCurrent();
    assert.equal(session.shell.status().status, 'ready', 'global_migration_shell_unconfirmed');
    // A complete mutation journal is a state checkpoint, not proof of later close or independent readback.
    session.journal.complete(sha({ planSha256, originals: session.engine.manifest(), shell: session.shell.snapshot() })); event('completed');
    phase = 'close'; event('issued'); admission.close(); admission = null; event('completed');
    phase = 'readback'; event('issued');
    const readback = await managedShellStatusCurrent({ root: session.plan.root });
    assert.equal(readback.status, 'ready', 'global_migration_independent_readback_unconfirmed'); event('completed');
    result = { status: 'completed', phase };
  } catch (error) {
    result = { status: phase === 'admission' ? 'stopped' : 'unknown', phase, errorSha256: sha(error instanceof Error ? error.name + ':' + error.message : String(error)) };
  }
  return await finish();

  async function finish() {
    if (admission) {
      try { admission.close(); } catch (error) { result = { status: 'unknown', phase: 'close', errorSha256: sha(error instanceof Error ? error.name + ':' + error.message : String(error)) }; }
      admission = null;
    }
    phase = 'terminal';
    try { event(result.status); } catch { result = { status: 'unknown', phase: 'receipt' }; }
    return { schema: 'caveat.global_migration_result.v1' as const, ...result, planSha256, runId, existingProcessOperations: 0, privilegeElevation: false as const };
  }
}
