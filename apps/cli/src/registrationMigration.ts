import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { openGlobalPathGuard, createGlobalMutationJournal, parseGlobalMutationJournal, writeGlobalPrivateEvidence,
  snapshotGlobalTree, managedDeploymentPaths, readManagedDeploymentAtRoot, preflightGlobalProcesses,
  type GlobalTreeRow, type ProcessProbeEvent, type GlobalProcessScope } from '@caveat/core';
import { editRegistrationNodeBytes } from './registrationNodeCodec.js';
import { registrationFileSpecs, type RegistrationSources } from './registrationProjection.js';

type Guard = Awaited<ReturnType<typeof openGlobalPathGuard>>;
type Preflight = (scope: GlobalProcessScope, emit: (event: ProcessProbeEvent) => void) => ReturnType<typeof preflightGlobalProcesses>;
export type RegistrationInput = { userHome: string; source: RegistrationSources; nodeVersion: string; clientsClosed?: boolean };
export type RegistrationEvent = { phase: string; event: string; runId: string | null; index?: number; pid?: number };
type Emit = (event: RegistrationEvent) => void;
type RegistrationResult = { status: 'completed' | 'restored' | 'unknown' | 'stopped'; planSha256: string; runId: string | null; phase: string; errorSha256?: string; evidenceSha256?: string; processAssessment?: unknown; existingProcessOperations: number; residualRisks: readonly string[] };
type Plan = { schema: 'caveat.registration_plan.v2'; home: string; source: RegistrationSources; nodeCommand: 'node';
  files: { path: string; original: GlobalTreeRow[]; beforeSha256: string; afterSha256: string }[];
  protected: { path: string; rows: GlobalTreeRow[] }[] };
type Source = { run: string; evidenceSha256: string; origin: string; start: boolean[]; restoring: boolean };
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown) => sha(JSON.stringify(value));
const errorHash = (error: unknown) => hash(error instanceof Error ? error.name + ':' + error.message : String(error));
const runName = (name: string) => /^(?:registration-migration|registration-recovery)-[a-f0-9]{32}$/.test(name);
const registrationResidualRisks = ['configuration writers with unreadable argv are not observed',
  'root or administrator writes are not excluded'] as const;
const snapshot = (path: string) => snapshotGlobalTree(path, { observeOnly: true, opaqueExternalLinks: true });
function fileBytes(path: string, expected: string) {
  assert.equal(realpathSync(dirname(path)), dirname(path), 'registration_parent_redirected');
  const before = snapshot(path);
  assert.ok(before.length === 1 && before[0]!.kind === 'file' && before[0]!.nlink === '1' && Number(before[0]!.size) <= 2 * 1024 * 1024, 'registration_file_invalid');
  assert.equal(before[0]!.sha256, expected, 'registration_file_changed');
  const bytes = readFileSync(path); assert.equal(sha(bytes), expected, 'registration_file_changed');
  assert.deepEqual(snapshot(path), before, 'registration_file_changed'); return bytes;
}
function validatePlan(plan: Plan, home: string) {
  assert.ok(plan.schema === 'caveat.registration_plan.v2' && plan.home === home && isAbsolute(home) && realpathSync(home) === home
    && plan.nodeCommand === 'node', 'registration_source_scope_invalid');
  const specs = registrationFileSpecs(plan.source, home);
  assert.ok(plan.files.length === 7 && plan.protected.length === 4, 'registration_scope_invalid');
  for (const [index, file] of plan.files.entries()) {
    assert.equal(file.path, specs.files[index]!.path, 'registration_plan_path_unbound');
    assert.equal(file.beforeSha256, specs.files[index]!.observed.sha256, 'registration_before_unbound');
    assert.match(file.afterSha256, /^[a-f0-9]{64}$/);
  }
  const paths = managedDeploymentPaths(home), payload = plan.protected[2]!.path;
  assert.equal(dirname(dirname(payload)), paths.releases, 'registration_payload_scope_invalid');
  assert.deepEqual(plan.protected.map(row => row.path), [paths.pointer, paths.entry, payload, join(dirname(payload), 'manifest.json')], 'registration_protected_scope_invalid');
  return specs;
}
function verifyProtected(plan: Plan) {
  for (const row of plan.protected) assert.deepEqual(snapshot(row.path), row.rows, 'registration_protected_changed');
}
async function freshProcesses(plan: Plan, preflight: Preflight, emit: Emit) {
  // Registration replaces these settings, so concurrent config writers must still stop it.
  const result = await preflight({ binAliases: [], observeConfigWriters: false, protectedPaths: plan.files.map(file => file.path) },
    event => emit({ phase: event.phase, event: event.event, pid: event.pid, runId: null }));
  if (result.status !== 'ready') throw Object.assign(Error('registration_process_preflight_stopped'), { preflight: result });
  return result;
}

/** Normal npm installation and Main15 both use Node from the client's PATH. */
export async function bindRegistrationAdmission(input: RegistrationInput, emit: Emit = () => {}, preflight: Preflight = preflightGlobalProcesses) {
  input = structuredClone(input); const home = resolve(input.userHome), specs = registrationFileSpecs(input.source, home);
  assert.ok(isAbsolute(input.userHome) && realpathSync(home) === home, 'registration_home_redirected');
  const paths = managedDeploymentPaths(home), active = readManagedDeploymentAtRoot(paths.root);
  const originals = specs.files.map(spec => {
    assert.equal(realpathSync(dirname(spec.path)), dirname(spec.path), 'registration_config_parent_redirected');
    const rows = snapshot(spec.path), observed = rows[0]!;
    assert.deepEqual([observed.dev, observed.ino, observed.uid, observed.gid, observed.mode, Number(observed.size), observed.sha256],
      [spec.observed.dev, spec.observed.ino, spec.observed.uid, spec.observed.gid, Number(spec.observed.mode), spec.observed.bytes, spec.observed.sha256], 'registration_saved_original_changed');
    const bytes = fileBytes(spec.path, spec.observed.sha256);
    return { rows, bytes, edited: editRegistrationNodeBytes(bytes, spec.format, spec.targets, specs.beforeNode, specs.proposedNode) };
  });
  const plan: Plan = { schema: 'caveat.registration_plan.v2', home, source: input.source, nodeCommand: 'node',
    files: originals.map((row, index) => ({ path: specs.files[index]!.path, original: row.rows, beforeSha256: row.edited.beforeSha256, afterSha256: row.edited.afterSha256 })),
    protected: [paths.pointer, paths.entry, active.packageRoot, join(dirname(active.packageRoot), 'manifest.json')].map(path => ({ path, rows: snapshot(path) })) };
  validatePlan(plan, home); verifyProtected(plan);
  const assessment = await freshProcesses(plan, preflight, emit);
  const verify = () => { verifyProtected(plan); for (const row of plan.files) fileBytes(row.path, row.beforeSha256); };
  verify();
  return { plan, planSha256: hash(plan), originals, verify, preflight, processAssessment: () => assessment };
}
function openAttempt(guard: Guard, plan: Plan, run: string, source?: Source) {
  const root = managedDeploymentPaths(plan.home).root;
  assert.equal(guard.observe(root, 'installer.lock'), null, 'registration_installer_busy');
  const directory = guard.createPrivateDirectory(root, run);
  writeGlobalPrivateEvidence(guard, directory, 'plan.json', plan);
  if (source) writeGlobalPrivateEvidence(guard, directory, 'source.json', source);
  const lock = guard.createJournal(directory, 'installer-lock.json', Buffer.from(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n'));
  assert.equal(guard.moveJournalNoReplace(lock, root, 'installer.lock').status, 'moved', 'registration_lock_acquire_unknown');
  let closed = false;
  return { directory, verify: () => { guard.assertCurrent(); guard.readJournal(lock); }, close: () => {
    if (closed) return;
    closed = true;
    assert.equal(guard.moveJournalNoReplace(lock, directory, 'installer-lock.json').status, 'moved', 'registration_lock_archive_unknown');
  } };
}
/** The source name remains present throughout this standard same-directory atomic replacement. */
function replaceFile(path: string, bytes: Buffer, expected: string, temp: string, emit: () => void) {
  const before = lstatSync(path); fileBytes(path, expected);
  writeFileSync(temp, bytes, { flag: 'wx', mode: before.mode & 0o777, flush: true });
  try {
    emit(); fileBytes(path, expected);
    renameSync(temp, path);
    fileBytes(path, sha(bytes));
  } finally {
    if (existsSync(temp) && !lstatSync(temp).isSymbolicLink() && sha(readFileSync(temp)) === sha(bytes)) unlinkSync(temp);
  }
}
function writeBackup(guard: Guard, directory: string, name: string, bytes: Buffer) {
  const token = guard.createJournal(directory, name, bytes.subarray(0, 65536));
  for (let offset = 65536; offset < bytes.length; offset += 65536) guard.appendJournal(token, bytes.subarray(offset, offset + 65536));
  assert.ok(guard.readJournal(token).equals(bytes), 'registration_backup_changed');
}
export async function planRegistrationMigration(input: RegistrationInput, emit: Emit = () => {}) {
  const admission = await bindRegistrationAdmission(input, emit);
  return { status: 'ready' as const, planSha256: admission.planSha256, files: 7, tokenEdits: 15, nodeCommand: 'node',
    processAssessment: admission.processAssessment(), residualRisks: registrationResidualRisks, filesystemWrites: 0, executionPermission: false as const };
}
export async function executeRegistrationMigration(input: RegistrationInput, expectedPlanSha256: string, emit: Emit = () => {}) {
  return executeRegistrationAdmission(await bindRegistrationAdmission(input, emit), expectedPlanSha256, emit);
}
export async function executeRegistrationAdmission(admission: Awaited<ReturnType<typeof bindRegistrationAdmission>>, expectedPlanSha256: string, emit: Emit = () => {}) {
  const { plan } = admission, root = managedDeploymentPaths(plan.home).root;
  let guard: Guard | undefined, attempt: ReturnType<typeof openAttempt> | undefined, run: string | null = null, phase = 'admission', result: RegistrationResult;
  try {
    assert.equal(hash(plan), expectedPlanSha256, 'registration_expected_plan_changed'); admission.verify();
    await freshProcesses(plan, admission.preflight, emit);
    guard = await openGlobalPathGuard([root]);
    run = 'registration-migration-' + randomBytes(16).toString('hex'); phase = 'backup'; attempt = openAttempt(guard, plan, run);
    for (const [index, row] of admission.originals.entries()) writeBackup(guard, attempt.directory, 'original-' + index, row.bytes);
    const journal = createGlobalMutationJournal(guard, attempt.directory, 'journal.jsonl', expectedPlanSha256), state = Array(7).fill(false) as boolean[];
    for (const [index, file] of plan.files.entries()) {
      attempt.verify(); verifyProtected(plan); phase = 'replace.' + index;
      fileBytes(file.path, file.beforeSha256); journal.intent(phase, 'manifest', hash(state));
      emit({ phase, event: 'intent-durable', runId: run, index });
      replaceFile(file.path, admission.originals[index]!.edited.bytes, file.beforeSha256, join(dirname(file.path), '.caveat-' + run + '-' + index + '.tmp'),
        () => emit({ phase, event: 'before-atomic-replace', runId: run, index }));
      state[index] = true;
      const evidence = writeGlobalPrivateEvidence(guard, attempt.directory, 'state-' + journal.read().nextSequence + '.json', { state });
      journal.result(phase, 'manifest', 'confirmed', evidence.sha256); emit({ phase, event: 'completed', runId: run, index });
    }
    phase = 'checkpoint'; journal.complete(hash(state)); attempt.close(); attempt = undefined; guard.close(); guard = undefined;
    phase = 'readback'; emit({ phase, event: 'issued', runId: run });
    const history = await loadHistory(plan.home, run, expectedPlanSha256);
    assert.deepEqual(history.state, state); verifyCurrent(history);
    emit({ phase, event: 'completed', runId: run });
    result = { status: 'completed', planSha256: expectedPlanSha256, runId: run, phase, existingProcessOperations: 0,
      processAssessment: admission.processAssessment(), residualRisks: registrationResidualRisks };
  } catch (error) {
    result = { status: run ? 'unknown' : 'stopped', planSha256: expectedPlanSha256, runId: run, phase,
      errorSha256: errorHash(error), processAssessment: (error as { preflight?: unknown }).preflight ?? admission.processAssessment(), existingProcessOperations: 0, residualRisks: registrationResidualRisks };
  } finally {
    try { try { attempt?.close(); } finally { guard?.close(); } }
    catch (error) { result = { status: 'unknown', planSha256: expectedPlanSha256, runId: run, phase: 'close', errorSha256: errorHash(error), existingProcessOperations: 0, residualRisks: registrationResidualRisks }; }
  }
  return result!;
}

type History = { plan: Plan; origin: string; state: boolean[]; evidence: { path: string; sha256: string }[]; evidenceSha256: string };
async function loadHistory(home: string, run: string, planSha256: string, seen = new Set<string>()): Promise<History> {
  assert.ok(runName(run) && seen.size < 8 && !seen.has(run), 'registration_source_cycle_or_bound'); seen.add(run);
  const directory = join(managedDeploymentPaths(home).root, run); assert.equal(realpathSync(directory), directory, 'registration_source_alias_forbidden');
  const guard = await openGlobalPathGuard([directory]);
  try {
    guard.assertPrivateDirectory(directory); const evidence: History['evidence'] = [];
    const read = (name: string) => { const bytes = guard.readPersistedJournal(directory, name); evidence.push({ path: join(directory, name), sha256: sha(bytes) }); return bytes; };
    const plan = JSON.parse(read('plan.json').toString('utf8')) as Plan; assert.equal(hash(plan), planSha256, 'registration_source_plan_changed'); const specs = validatePlan(plan, home);
    const journal = parseGlobalMutationJournal(read('journal.jsonl'), planSha256);
    assert.ok(['ready', 'complete'].includes(journal.status), 'registration_source_pending_torn_or_unknown');
    let source: Source | undefined, parent: History | undefined;
    if (existsSync(join(directory, 'source.json'))) {
      source = JSON.parse(read('source.json').toString('utf8')) as Source;
      parent = await loadHistory(home, source.run, planSha256, seen);
      assert.equal(parent.evidenceSha256, source.evidenceSha256, 'registration_source_evidence_changed');
      assert.deepEqual(source.start, parent.state, 'registration_source_seed_changed');
      assert.equal(source.origin, parent.origin, 'registration_source_origin_changed');
    }
    const state = source ? [...source.start] : Array(7).fill(false) as boolean[];
    for (const row of journal.records) {
      if (row.kind === 'intent') {
        assert.equal(row.stateSha256, hash(state), 'registration_source_intent_changed'); continue;
      }
      if (row.kind === 'complete') { assert.equal(row.stateSha256, hash(state), 'registration_checkpoint_changed'); continue; }
      const match = /^(replace|restore)\.([0-6])$/.exec(row.step); assert.ok(match, 'registration_source_step_invalid');
      assert.equal(row.operation, match[1] === 'restore' ? 'restore' : 'manifest', 'registration_source_operation_invalid');
      const next = [...state]; next[Number(match[2])] = match[1] === 'replace';
      const bytes = read('state-' + row.sequence + '.json'); assert.equal(sha(bytes), row.stateSha256, 'registration_source_state_changed');
      assert.deepEqual(JSON.parse(bytes.toString('utf8')), { state: next }, 'registration_source_state_changed'); state.splice(0, state.length, ...next);
    }
    const origin = parent?.origin ?? run;
    if (!parent) for (const [index, file] of plan.files.entries()) {
      const bytes = fileBytes(join(directory, 'original-' + index), file.beforeSha256), spec = specs.files[index]!;
      assert.equal(editRegistrationNodeBytes(bytes, spec.format, spec.targets, specs.beforeNode, specs.proposedNode).afterSha256, file.afterSha256, 'registration_source_after_unbound');
    }
    const refs = [...(parent?.evidence ?? []), ...evidence];
    if (!parent) for (const [index, file] of plan.files.entries()) refs.push({ path: join(directory, 'original-' + index), sha256: file.beforeSha256 });
    return { plan, origin, state, evidence: refs, evidenceSha256: hash({ refs, state }) };
  } finally { guard.close(); }
}
function verifyCurrent(history: History) {
  verifyProtected(history.plan);
  for (const ref of history.evidence) fileBytes(ref.path, ref.sha256);
  for (const [index, file] of history.plan.files.entries()) fileBytes(file.path, history.state[index] ? file.afterSha256 : file.beforeSha256);
}
export async function planRegistrationRecovery(home: string, run: string, planSha256: string, emit: Emit = () => {}, preflight: Preflight = preflightGlobalProcesses) {
  const history = await loadHistory(home, run, planSha256); verifyCurrent(history);
  const processAssessment = await freshProcesses(history.plan, preflight, emit); verifyCurrent(history);
  return { status: history.state.some(Boolean) ? 'ready' as const : 'already-original' as const,
    planSha256, evidenceSha256: history.evidenceSha256, processAssessment, residualRisks: registrationResidualRisks,
    currentObjects: 'confirmed' as const, filesystemWrites: 0, executionPermission: false as const };
}
export async function executeRegistrationRecovery(home: string, sourceRun: string, planSha256: string, evidenceSha256: string,
  emit: Emit = () => {}, preflight: Preflight = preflightGlobalProcesses, _clientsClosed = false) {
  let run: string | null = null, guard: Guard | undefined, attempt: ReturnType<typeof openAttempt> | undefined, phase = 'admission', result: RegistrationResult;
  try {
    const history = await loadHistory(home, sourceRun, planSha256); assert.equal(history.evidenceSha256, evidenceSha256, 'registration_source_evidence_changed'); verifyCurrent(history);
    const processAssessment = await freshProcesses(history.plan, preflight, emit); verifyCurrent(history);
    const root = managedDeploymentPaths(home).root; guard = await openGlobalPathGuard([root]);
    run = 'registration-recovery-' + randomBytes(16).toString('hex');
    attempt = openAttempt(guard, history.plan, run, { run: sourceRun, evidenceSha256, origin: history.origin, start: history.state, restoring: true });
    const journal = createGlobalMutationJournal(guard, attempt.directory, 'journal.jsonl', planSha256), state = [...history.state];
    for (const [index, file] of history.plan.files.entries()) if (state[index]) {
      phase = 'restore.' + index; attempt.verify(); verifyCurrent({ ...history, state });
      const bytes = fileBytes(join(root, history.origin, 'original-' + index), file.beforeSha256);
      journal.intent(phase, 'restore', hash(state)); emit({ phase, event: 'intent-durable', runId: run, index });
      replaceFile(file.path, bytes, file.afterSha256, join(dirname(file.path), '.caveat-' + run + '-' + index + '.tmp'),
        () => emit({ phase, event: 'before-atomic-replace', runId: run, index }));
      state[index] = false;
      const evidence = writeGlobalPrivateEvidence(guard, attempt.directory, 'state-' + journal.read().nextSequence + '.json', { state });
      journal.result(phase, 'restore', 'confirmed', evidence.sha256); emit({ phase, event: 'completed', runId: run, index });
    }
    journal.complete(hash(state)); attempt.close(); attempt = undefined; guard.close(); guard = undefined;
    phase = 'readback'; emit({ phase, event: 'issued', runId: run }); verifyCurrent(await loadHistory(home, run, planSha256)); emit({ phase, event: 'completed', runId: run });
    result = { status: 'restored', planSha256, evidenceSha256, runId: run, phase, processAssessment, existingProcessOperations: 0, residualRisks: registrationResidualRisks };
  } catch (error) {
    result = { status: run ? 'unknown' : 'stopped', planSha256, runId: run, phase, errorSha256: errorHash(error), existingProcessOperations: 0, residualRisks: registrationResidualRisks };
  } finally {
    try { try { attempt?.close(); } finally { guard?.close(); } }
    catch (error) { result = { status: 'unknown', planSha256, runId: run, phase: 'close', errorSha256: errorHash(error), existingProcessOperations: 0, residualRisks: registrationResidualRisks }; }
  }
  return result!;
}
export async function inspectRegistrationJournal(home: string, run: string, planSha256: string) {
  assert.ok(runName(run) && isAbsolute(home) && realpathSync(home) === home, 'registration_source_scope_invalid');
  const directory = join(managedDeploymentPaths(home).root, run); assert.equal(realpathSync(directory), directory, 'registration_source_alias_forbidden');
  const guard = await openGlobalPathGuard([directory]);
  try {
    guard.assertPrivateDirectory(directory);
    const plan = JSON.parse(guard.readPersistedJournal(directory, 'plan.json').toString('utf8')) as Plan; assert.equal(hash(plan), planSha256); validatePlan(plan, home);
    const journal = parseGlobalMutationJournal(guard.readPersistedJournal(directory, 'journal.jsonl'), planSha256);
    return { schema: 'caveat.registration_journal_inspection.v1', status: 'observed', planSha256, journalStatus: journal.status,
      journalSha256: journal.bytesSha256, currentObjects: 'not-assessed', executionPermission: false, filesystemWrites: 0, childProcesses: 0 };
  } finally { guard.close(); }
}
