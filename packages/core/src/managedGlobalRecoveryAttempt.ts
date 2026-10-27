import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { openGlobalPathGuard } from './managedGlobalGuard.js';
import { parseGlobalMutationJournal } from './managedGlobalJournal.js';
import type { RecoveryRecord } from './managedGlobalRecoveryModel.js';
import type { GlobalRecoveryBudget } from './managedGlobalRecovery.js';

export type GlobalRecoveryAttemptEvidence = { source: { schema: string; sourceRun: string; planSha256: string; evidenceSha256: string; journalSha256: string; admission?: unknown };
  journal: ReturnType<typeof parseGlobalMutationJournal>; states: Map<number, RecoveryRecord>; verifyEvidence: () => void;
  references: { run: string; name: string; bytes: number; sha256: string }[] };

/** Journal inspection never assesses current object identities or authorizes another execution. */
export function inspectGlobalRecoveryAttempt(runDirectory: string, planSha256: string) {
  return withGlobalRecoveryAttemptEvidence(runDirectory, planSha256, async ({ source, journal }) => ({ schema: 'caveat.global_recovery_attempt_inspection.v1' as const, status: ['ready', 'complete'].includes(journal.status) ? 'observed' as const : 'stopped' as const,
    journalStatus: journal.status, journalSha256: journal.bytesSha256, sourceEvidenceSha256: source.evidenceSha256 as string, currentObjects: 'not-assessed' as const, executionPermission: false as const, filesystemWrites: 0, childProcesses: 0 }));
}

export async function withGlobalRecoveryAttemptEvidence<T>(runDirectory: string, planSha256: string, use: (evidence: GlobalRecoveryAttemptEvidence) => Promise<T>, budget: GlobalRecoveryBudget = { files: 0, bytes: 0 }) {
  assert.ok(isAbsolute(runDirectory) && resolve(runDirectory) === runDirectory && /^global-recovery-[a-f0-9]{32}$/.test(basename(runDirectory)), 'global_recovery_attempt_path_invalid');
  assert.equal(realpathSync(runDirectory), runDirectory, 'global_recovery_attempt_alias_forbidden');
  const guard = await openGlobalPathGuard([runDirectory]);
  try {
    guard.assertPrivateDirectory(runDirectory); assert.equal(realpathSync(runDirectory), runDirectory, 'global_recovery_attempt_alias_forbidden'); const cached = new Map<string, Buffer>(); let totalBytes = 0;
    const read = (name: string) => {
      const bytes = guard.readPersistedJournal(runDirectory, name); totalBytes += bytes.length; budget.files++; budget.bytes += bytes.length;
      assert.ok(budget.files <= 256 && budget.bytes <= 64 * 1024 * 1024, 'global_recovery_chain_evidence_bound');
      assert.ok(cached.size < 256 && totalBytes <= 64 * 1024 * 1024, 'global_recovery_attempt_evidence_bound'); cached.set(name, bytes); return bytes;
    };
    const decode = (bytes: Buffer) => { const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
      assert.ok(Buffer.from(JSON.stringify(value) + '\n').equals(bytes), 'global_recovery_attempt_noncanonical'); return value; };
    const source = decode(read('source.json'));
    assert.deepEqual(Object.keys(source).sort(), ['schema', 'sourceRun', 'planSha256', 'evidenceSha256', 'journalSha256', ...(source.schema === 'caveat.global_recovery_source.v2' ? ['admission'] : [])].sort(), 'global_recovery_attempt_source_fields');
    assert.ok(['caveat.global_recovery_source.v1', 'caveat.global_recovery_source.v2'].includes(source.schema) && source.planSha256 === planSha256
      && /^global-(migration|recovery)-[a-f0-9]{32}$/.test(source.sourceRun)
      && [source.planSha256, source.evidenceSha256, source.journalSha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'global_recovery_attempt_source_invalid');
    assert.equal(basename(runDirectory), 'global-recovery-' + source.evidenceSha256.slice(0, 32), 'global_recovery_attempt_name_unbound');
    const journal = parseGlobalMutationJournal(read('journal.jsonl'), planSha256);
    const states = new Map<number, RecoveryRecord>();
    for (const row of journal.records) if (row.kind === 'result' && row.stateSha256) {
      const bytes = read('state-' + journal.header.runId + '-' + row.sequence + '.json');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), row.stateSha256, 'global_recovery_attempt_state_changed');
      const state = decode(bytes);
      assert.ok(state.schema === 'caveat.global_recovery_state.v1' && state.sourceEvidenceSha256 === source.evidenceSha256
        && state.step === row.step && state.operation === row.operation && state.state.schema === 'caveat.global_recovery_objects.v1'
        && state.state.sourceEvidenceSha256 === source.evidenceSha256
        && Array.isArray(state.state.objects) && state.state.objects.length >= 1 && state.state.objects.length <= 5
        && Array.isArray(state.state.generated) && state.state.generated.length >= 2 && state.state.generated.length <= 4, 'global_recovery_attempt_state_invalid');
      states.set(row.sequence, state);
    }
    const verifyEvidence = () => { assert.equal(realpathSync(runDirectory), runDirectory, 'global_recovery_attempt_alias_forbidden'); for (const [name, bytes] of cached) assert.ok(guard.readPersistedJournal(runDirectory, name).equals(bytes), 'global_recovery_attempt_changed_during_read'); };
    verifyEvidence();
    return await use({ source, journal, states, verifyEvidence, references: [...cached].map(([name, bytes]) => ({ run: basename(runDirectory), name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) });
  } finally { guard.close(); }
}
