import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { openGlobalPathGuard } from './managedGlobalGuard.js';

type Guard = Awaited<ReturnType<typeof openGlobalPathGuard>>;
export type GlobalJournalOperation = 'retain' | 'uninstall' | 'wrapper' | 'restore' | 'manifest';
type Header = { schema: 'caveat.global_journal.v1'; planSha256: string; runId: string };
type Intent = { sequence: number; previousSha256: string; kind: 'intent'; step: string; operation: GlobalJournalOperation; stateSha256: string };
type Result = Omit<Intent, 'kind' | 'stateSha256'> & { kind: 'result'; outcome: 'confirmed' | 'unknown'; stateSha256: string | null };
type Complete = { sequence: number; previousSha256: string; kind: 'complete'; stateSha256: string };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value: unknown, names: string[]) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'global_journal_object_required');
  const actual = Object.keys(value).sort(), expected = names.sort();
  assert.ok(actual.length === expected.length && actual.every((key, index) => key === expected[index]), 'global_journal_fields_invalid');
};
const line = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n', 'utf8');

/** Reads owned bytes only. Pending, unknown and torn records never grant permission to replay an action. */
export function parseGlobalMutationJournal(bytes: Buffer, expectedPlanSha256: string) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 16 * 1024 * 1024, 'global_journal_total_bound');
  assert.ok(digest(expectedPlanSha256), 'global_journal_plan_hash_required');
  const end = bytes.lastIndexOf(10); assert.ok(end >= 0, 'global_journal_header_incomplete');
  const lines = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, end + 1)).split('\n'); lines.pop();
  assert.ok(lines.length > 0 && lines.length <= 10000, 'global_journal_record_count_bound');
  const decode = (text: string) => {
    assert.ok(Buffer.byteLength(text, 'utf8') <= 65535, 'global_journal_record_bound');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (error) { throw Object.assign(Error('global_journal_json_invalid'), { errorSha256: hash(Buffer.from(error instanceof Error ? error.name + ':' + error.message : String(error))) }); }
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'global_journal_object_required');
    assert.ok(JSON.stringify(value) === text, 'global_journal_noncanonical_record'); return value;
  };
  const header = decode(lines[0]!) as Header;
  keys(header, ['schema', 'planSha256', 'runId']);
  assert.ok(header.schema === 'caveat.global_journal.v1' && header.planSha256 === expectedPlanSha256 && typeof header.runId === 'string' && /^[a-f0-9]{32}$/.test(header.runId), 'global_journal_header_invalid');
  let previousSha256 = hash(Buffer.from(lines[0]! + '\n')), pending: Intent | null = null, unknown = false, complete = false;
  const records: (Intent | Result | Complete)[] = [], steps = new Set<string>();
  for (const text of lines.slice(1)) {
    assert.ok(!unknown && !complete, 'global_journal_after_terminal');
    const row = decode(text) as Intent | Result | Complete;
    const base = ['sequence', 'previousSha256', 'kind', 'stateSha256'];
    if (row.kind === 'intent' || row.kind === 'result') base.push('step', 'operation');
    if (row.kind === 'result') base.push('outcome'); keys(row, base);
    assert.ok(row.sequence === records.length + 1 && row.previousSha256 === previousSha256, 'global_journal_chain_invalid');
    if (row.kind === 'intent' || row.kind === 'result') {
      assert.ok(typeof row.step === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(row.step)
        && ['retain', 'uninstall', 'wrapper', 'restore', 'manifest'].includes(row.operation), 'global_journal_operation_invalid');
    }
    if (row.kind === 'intent') {
      assert.ok(!pending && !steps.has(row.step) && digest(row.stateSha256), 'global_journal_intent_invalid'); pending = row;
    } else if (row.kind === 'result') {
      assert.ok(pending && row.step === pending.step && row.operation === pending.operation
        && (row.outcome === 'confirmed' && digest(row.stateSha256) || row.outcome === 'unknown' && (row.stateSha256 === null || digest(row.stateSha256))), 'global_journal_result_invalid');
      unknown = row.outcome === 'unknown'; steps.add(row.step); pending = null;
    } else {
      assert.ok(row.kind === 'complete' && !pending && digest(row.stateSha256), 'global_journal_complete_invalid'); complete = true;
    }
    records.push(row); previousSha256 = hash(Buffer.from(text + '\n'));
  }
  return { header, records, pending, nextSequence: records.length + 1, lastSha256: previousSha256,
    bytesSha256: hash(bytes), tornBytes: bytes.length - end - 1,
    status: end !== bytes.length - 1 ? 'torn' as const : unknown ? 'unknown' as const : complete ? 'complete' as const : pending ? 'pending' as const : 'ready' as const };
}

/** Only a new private file may be written. Existing journals are read-only inputs for separate recovery. */
export function createGlobalMutationJournal(guard: Guard, directory: string, name: string, planSha256: string) {
  assert.ok(digest(planSha256), 'global_journal_plan_hash_required');
  const header: Header = { schema: 'caveat.global_journal.v1', planSha256, runId: randomBytes(16).toString('hex') };
  const token = guard.createJournal(directory, name, line(header));
  const read = () => parseGlobalMutationJournal(guard.readJournal(token), planSha256);
  const append = (event: Omit<Intent, 'sequence' | 'previousSha256'> | Omit<Result, 'sequence' | 'previousSha256'> | Omit<Complete, 'sequence' | 'previousSha256'>) => {
    const bytes = guard.readJournal(token), current = parseGlobalMutationJournal(bytes, planSha256);
    const record = line({ sequence: current.nextSequence, previousSha256: current.lastSha256, ...event });
    parseGlobalMutationJournal(Buffer.concat([bytes, record]), planSha256);
    guard.appendJournal(token, record); return read();
  };
  return {
    read,
    intent(step: string, operation: GlobalJournalOperation, stateSha256: string) { return append({ kind: 'intent', step, operation, stateSha256 }); },
    result(step: string, operation: GlobalJournalOperation, outcome: 'confirmed' | 'unknown', stateSha256: string | null) { return append({ kind: 'result', step, operation, outcome, stateSha256 }); },
    complete(stateSha256: string) { return append({ kind: 'complete', stateSha256 }); },
  };
}
