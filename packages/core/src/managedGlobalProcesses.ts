import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMacForeignArgumentDenial, nativeGlobalProcessTables } from './managedProcessNative.js';
import type { NativeProcessRecord, NativeProcessTables, ProcessProbeEvent } from './managedProcessNative.js';

export type GlobalProcessProtection = { objects: { path: string; originalPath: string; dev: string; ino: string }[]; absent: string[]; postMutation: boolean; mutationPaths?: string[] };
/** The callback closes over held native proof; no CLI or persisted-plan callback is accepted. */
export type GlobalProcessScope = { packageRoot?: string; npmRoot?: string; binAliases: string[]; protectedPaths?: string[]; runtimeExecutables?: string[]; retainedRoots?: string[]; protection?: () => GlobalProcessProtection };
type Classification = 'self' | 'non-executing' | 'consumer' | 'writer' | 'unknown' | 'foreign-user' | 'foreign-user-unobservable' | 'ancestor' | 'transient' | 'outside-observed-scope' | 'same-uid-unresolvable-image';
export type GlobalProcessAssessment = { pid: number; birth: string | null; classification: Classification; reason: string; resolution?: { action: 'close-process' | 'finish-npm-operation' | 'unresolved'; instruction: string }; executableSha256?: string; imageDeleted?: boolean; runtime?: boolean; runtimeKind?: 'node' | 'selected' | 'current-image' | 'interpreter-or-helper'; observation?: { owner: 'same' | 'foreign' | 'unknown'; missing: string[]; nativeIssues: string[] } };
const normalized = (value: string, fold: boolean) => {
  const slash = value.replaceAll('\\', '/').replace(/\/$/, '');
  return fold ? slash.toLowerCase() : slash;
};
const absolute = (value: string) => value.startsWith('/') || /^[a-z]:\//i.test(value);
function validateScope(scope: GlobalProcessScope) {
  assert.ok(!scope.protectedPaths || Array.isArray(scope.protectedPaths) && scope.protectedPaths.length <= 64, 'process_protected_scope_bound');
  assert.ok(!scope.runtimeExecutables || Array.isArray(scope.runtimeExecutables) && scope.runtimeExecutables.length <= 8, 'process_runtime_scope_bound');
  assert.ok(typeof scope.packageRoot === 'string' && typeof scope.npmRoot === 'string'
    || scope.packageRoot === undefined && scope.npmRoot === undefined && scope.protectedPaths?.length, 'process_scope_required');
  assert.ok(!scope.retainedRoots || Array.isArray(scope.retainedRoots) && scope.retainedRoots.length <= 64, 'process_retained_scope_bound');
  const paths = [...(scope.retainedRoots ?? []), ...(scope.packageRoot === undefined ? [] : [scope.packageRoot, scope.npmRoot!]), ...scope.binAliases, ...(scope.protectedPaths ?? []), ...(scope.runtimeExecutables ?? [])].map(value => normalized(value, false));
  assert.ok(paths.every(value => absolute(value) && value.length > 1 && !/[\x00-\x1f]/.test(value) && !value.split('/').some(part => part === '.' || part === '..')), 'absolute_process_scope_required');
}
function validateProtection(scope: GlobalProcessScope, proof: GlobalProcessProtection) {
  assert.ok(Array.isArray(proof.objects) && proof.objects.length > 0 && proof.objects.length <= 400000
    && proof.objects.every(row => absolute(row.path) && absolute(row.originalPath) && !/[\x00-\x1f]/.test(row.path + row.originalPath)
      && /^\d+$/.test(row.dev) && /^[1-9]\d*$/.test(row.ino)), 'process_protected_objects_invalid');
  assert.ok(!proof.mutationPaths || proof.mutationPaths.length <= 256 && proof.mutationPaths.every(absolute), 'process_mutation_scope_invalid');
  assert.equal(typeof proof.postMutation, 'boolean', 'process_protection_phase_invalid');
  assert.ok(Array.isArray(proof.absent) && proof.absent.length <= 10000 && proof.absent.every(absolute), 'process_protected_absences_invalid');
  for (const path of [scope.packageRoot, scope.npmRoot, ...(scope.runtimeExecutables ?? [])].filter((value): value is string => !!value)) {
    assert.ok(proof.objects.some(row => row.originalPath === path || row.path === path), 'process_protected_scope_incomplete');
  }
  for (const path of scope.binAliases) assert.ok(proof.objects.some(row => row.originalPath === path || row.path === path) || proof.absent.includes(path), 'process_protected_alias_unproved');
}
function nodeScript(argv: string[]) {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--') return argv[index + 1] ?? null;
    if (/^--(?:disable-warning|inspect|inspect-brk)=/.test(arg) || ['--no-warnings', '--experimental-sqlite', '--enable-source-maps', '--inspect', '--inspect-brk'].includes(arg)) continue;
    return arg.startsWith('-') ? null : arg;
  }
  return null;
}
function hasLiteral(value: string, path: string) {
  let offset = value.indexOf(path);
  while (offset >= 0) {
    const next = value[offset + path.length];
    if (next === undefined || !/[\p{L}\p{N}_.-]/u.test(next)) return true;
    offset = value.indexOf(path, offset + 1);
  }
  return false;
}

export const globalProcessResidualRisks = [
  'process tables cannot exclude a later dynamic import of the old global by an outside-scope script or helper, including ELECTRON_RUN_AS_NODE',
  'a same-uid Node with an unresolvable executable may later dynamically import the old global; the retained quarantine makes that import fail',
  'a later import may fail after the old global is retained in quarantine; existing data is never overwritten',
  'foreign-user processes not bound to a Node identity may read, copy or write the old global; root or administrator exclusivity is not proven',
] as const;

/** Observation scope is explicit; outside-scope classification is not proof against future dynamic imports. */
export function assessGlobalProcesses(scope: GlobalProcessScope, tables: NativeProcessTables, protection?: GlobalProcessProtection) {
  validateScope(scope);
  if (protection) validateProtection(scope, protection);
  const fold = tables.caseInsensitive, norm = (value: string) => normalized(value, fold);
  const root = scope.packageRoot === undefined ? null : norm(scope.packageRoot), npm = scope.npmRoot === undefined ? null : norm(scope.npmRoot), aliases = scope.binAliases.map(norm);
  const retainedRoots = [...(scope.retainedRoots ?? []).map(norm), ...(protection?.mutationPaths ?? []).map(norm)];
  for (const row of protection?.objects ?? []) if (row.path !== row.originalPath) {
    const path = norm(row.path);
    if (!retainedRoots.some(root => path === root || path.startsWith(root + '/'))) retainedRoots.push(path);
    assert.ok(retainedRoots.length <= 128, 'process_retained_scope_bound');
  }
  const paths = [...retainedRoots, ...(root ? [root] : []), ...(npm ? [npm] : []), ...aliases, ...(scope.protectedPaths ?? []).map(norm)];
  const within = (value: string, parent: string) => value === parent || value.startsWith(parent + '/');
  const records: GlobalProcessAssessment[] = [], errors = [...tables.errors];
  const before = new Map(tables.before.map(row => [row.pid, row])), after = new Map(tables.after.map(row => [row.pid, row]));
  if (!before.size || !after.size || before.size !== tables.before.length || after.size !== tables.after.length) errors.push('process_table_empty_or_duplicate');
  const stable = ({ pid, ppid, birth, uid, executable, state, kernel, ownerProof }: NativeProcessRecord) =>
    ({ pid, ppid, birth, uid, executable, state: state === 'Z' ? 'Z' : 'live', kernel, ownerProof });
  const unchanged = (first: NativeProcessRecord | undefined, last: NativeProcessRecord | undefined) => !!first && !!last && isDeepStrictEqual(stable(first), stable(last));
  const ancestors = new Set<number>(), visited = new Set([tables.selfPid]);
  let parent = before.get(tables.selfPid)?.ppid;
  for (let depth = 0; parent !== null && parent !== undefined && parent > 0; depth++) {
    if (depth >= 128 || visited.has(parent)) { errors.push('process_ancestor_cycle_or_bound'); break; }
    visited.add(parent);
    const first = before.get(parent), last = after.get(parent);
    if (!unchanged(first, last) || !first?.birth || !first.executable || !first.argv || first.reason) break;
    ancestors.add(parent); parent = first.ppid;
  }
  const ownUid = before.get(tables.selfPid)?.uid;
  for (const pid of new Set([...before.keys(), ...after.keys()])) {
    const first = before.get(pid), last = after.get(pid), row = first ?? last!;
    const result: GlobalProcessAssessment = { pid, birth: row.birth, classification: 'unknown', reason: 'process_identity_unverified' };
    const observed = [first, last].filter((value): value is NativeProcessRecord => !!value);
    const knownOwner = ownUid !== null && ownUid !== undefined && observed.every(entry => entry.uid !== null);
    result.observation = {
      owner: knownOwner && observed.every(entry => entry.uid === ownUid) ? 'same' : knownOwner && observed.every(entry => entry.uid !== ownUid) ? 'foreign' : 'unknown',
      missing: [...new Set(observed.flatMap(entry => ['uid', 'birth', 'ppid', 'executable', 'argv'].filter(key => entry[key as keyof NativeProcessRecord] === null)))],
      nativeIssues: [...new Set(observed.flatMap(row => [row.argumentFailure ? 'darwin-argv:' + row.argumentFailure.stage + ':' + row.argumentFailure.nativeCode + (row.argumentFailure.decodeReason ? ':' + row.argumentFailure.decodeReason : '') : null,
        row.ownerFailure ? 'windows-owner:' + row.ownerFailure.stage + ':' + row.ownerFailure.nativeCode : null,
        row.ownerMethod ? 'windows-owner-method:' + row.ownerMethod.stage + ':' + row.ownerMethod.returnValue : null,
        row.kernelFailure ? 'darwin-kernel:' + row.kernelFailure.stage + ':' + row.kernelFailure.nativeCode : null,
        row.text ? 'darwin-text:' + row.text.status + ':' + row.text.stage + ':' + row.text.nativeCode : null,
        row.windowsFields?.executable !== undefined && row.windowsFields.executable !== 'present' ? 'windows-metadata:executable-' + row.windowsFields.executable + ':null' : null,
        row.windowsFields?.arguments !== undefined && row.windowsFields.arguments !== 'present' ? 'windows-metadata:arguments-' + row.windowsFields.arguments + ':null' : null].filter((value): value is string => value !== null)))],
    };
    records.push(result);
    // Check every observed argv, including foreign, ancestor, transient and inline commands.
    const image = row.executable ? norm(row.executable.path).replace(/ \(deleted\)$/, '') : null;
    result.imageDeleted = !!row.executable?.path.endsWith(' (deleted)');
    const isRuntime = !!image && (/(?:^|\/)(?:node|nodejs|bun|deno|electron|[^/]*helper|python[\d.]*|ruby[\d.]*|perl[\d.]*|php[\d.]*|java|pwsh|powershell|cmd|sh|bash|zsh|fish|dash|ksh|csh|tcsh)(?:\.exe)?$/.test(image)
      || (scope.runtimeExecutables ?? []).some(path => norm(path) === image)
      || row.executable?.dev === tables.selfExecutable.dev && row.executable?.ino === tables.selfExecutable.ino);
    result.runtime = isRuntime;
    if (isRuntime) result.runtimeKind = /(?:^|\/)(?:node|nodejs)(?:\.exe)?$/.test(image!) ? 'node'
      : (scope.runtimeExecutables ?? []).some(path => norm(path) === image) ? 'selected'
      : row.executable?.dev === tables.selfExecutable.dev && row.executable?.ino === tables.selfExecutable.ino ? 'current-image' : 'interpreter-or-helper';
    const bound = (entry: NativeProcessRecord) => {
      const path = entry.executable ? norm(entry.executable.path).replace(/ \(deleted\)$/, '') : null;
      const argv = entry.argv?.map(norm);
      const node = !!path && (/(?:^|\/)(?:node|nodejs)(?:\.exe)?$/.test(path)
        || (scope.runtimeExecutables ?? []).some(value => norm(value) === path)
        || entry.executable?.dev === tables.selfExecutable.dev && entry.executable?.ino === tables.selfExecutable.ino);
      const candidate = node && argv ? nodeScript(argv) : null;
      if (path && retainedRoots.some(root => within(path, root)) || candidate && retainedRoots.some(root => within(candidate, root))) return 'consumer';
      if (npm && (path && within(path, npm) || candidate && within(candidate, npm))) return 'writer';
      if (root && path && within(path, root) || candidate && (root && within(candidate, root) || aliases.includes(candidate))) return 'consumer';
      return null;
    };
    const binding = [first, last].filter((value): value is NativeProcessRecord => !!value).map(bound).find(Boolean);
    if (binding) { result.classification = binding; result.reason = 'bound_scope_executable_or_script'; continue; }
    const literal = [first, last].some(entry => entry?.argv?.some(value => paths.some(path => hasLiteral(norm(value), path))));
    // The migration CLI itself carries scope paths. Only its stable kernel identity can exempt that argv.
    const self = pid === tables.selfPid && unchanged(first, last) && !first?.reason && !last?.reason && !!last?.argv && !!row.birth && row.uid !== null && !!row.argv
      && !!row.executable && norm(row.executable.path) === norm(tables.selfExecutable.path)
      && row.executable.dev === tables.selfExecutable.dev && row.executable.ino === tables.selfExecutable.ino;
    if (self) { result.classification = 'self'; result.reason = 'current_pid_birth_uid_and_kernel_executable_bound'; continue; }
    if (literal) { result.reason = 'scope_literal_outside_bound_script'; continue; }
    if (first && last && typeof ownUid === 'number' && ownUid !== 0 && typeof first.uid === 'number' && first.uid !== ownUid
      && unchanged(first, last) && first.executable && last.executable && !first.reason && !last.reason
      && first.ownerProof === 'darwin-kinfo-proc' && last.ownerProof === 'darwin-kinfo-proc'
      && (isMacForeignArgumentDenial(first) || isMacForeignArgumentDenial(last)) && (first.argv || isMacForeignArgumentDenial(first)) && (last.argv || isMacForeignArgumentDenial(last))) {
      if (isRuntime && result.runtimeKind !== 'interpreter-or-helper') { result.reason = 'foreign_runtime_arguments_unavailable'; continue; }
      result.classification = 'foreign-user-unobservable'; result.reason = 'darwin_foreign_uid_bound_image_einval'; continue;
    }
    const unresolvable = (entry: NativeProcessRecord) => entry.ownerProof === 'darwin-kinfo-proc' && entry.imageIdentityBound === true
      && !entry.executable && !!entry.argv && !entry.reason && entry.kernelFailure?.stage === 'image-proc-pidpath' && [2, 3].includes(entry.kernelFailure.nativeCode!);
    if (first && last && first.uid === ownUid && ownUid !== null && ownUid !== undefined && unchanged(first, last) && unresolvable(first) && unresolvable(last)) {
      const text = [first, last].flatMap(entry => entry.text?.identities ?? []);
      if (protection && text.some(image => protection.objects.some(object => object.dev === image.dev && object.ino === image.ino))) {
        result.classification = 'consumer'; result.reason = 'protected_text_device_inode'; continue;
      }
      // The unreadable-text postcheck relies on the real Darwin executable-directory rename acceptance check.
      if (protection && first.text && last.text) {
        result.classification = 'same-uid-unresolvable-image'; result.reason = protection.postMutation ? 'darwin_unresolvable_image_with_confirmed_locations' : 'darwin_unresolvable_image_with_original_locations'; continue;
      }
      result.reason = 'unresolvable_image_protected_objects_unproved'; continue;
    }
    if (first && last && (!unchanged(first, last) || first.reason || last.reason || !first.argv !== !last.argv)) {
      if (first.birth !== last.birth) result.reason = 'process_birth_changed';
      else if (first.executable && last.executable && !isDeepStrictEqual(first.executable, last.executable)) result.reason = 'process_executable_changed';
      else if (!first.executable !== !last.executable) result.reason = 'process_executable_observation_incomplete';
      else if (first.uid !== last.uid) result.reason = 'process_owner_changed';
      else if (first.ppid !== last.ppid) result.reason = 'process_parent_changed';
      else result.reason = 'process_metadata_observation_incomplete';
      continue;
    }
    if (row.reason || !row.birth || row.ppid === null) { result.reason = row.reason ?? 'process_birth_or_parent_missing'; continue; }
    if (first && last && (row.kernel || first.state === 'Z' && last.state === 'Z')) {
      result.classification = 'non-executing'; result.reason = row.kernel ?? 'same_birth_kernel_zombie'; continue;
    }
    if (row.uid === null || ownUid === null || ownUid === undefined || !row.argv) { result.reason = 'process_owner_or_arguments_missing'; continue; }
    if (row.uid !== ownUid) { result.classification = first && last ? 'foreign-user' : 'transient'; result.reason = 'foreign_uid_birth_and_arguments_outside_scope'; continue; }
    if (!row.executable || !absolute(norm(row.executable.path)) || !/^\d+$/.test(row.executable.dev) || !/^[1-9]\d*$/.test(row.executable.ino)) {
      result.reason = 'process_executable_or_arguments_missing'; continue;
    }
    result.executableSha256 = createHash('sha256').update(JSON.stringify(row.executable)).digest('hex');
    result.classification = !first || !last ? 'transient' : ancestors.has(pid) ? 'ancestor' : 'outside-observed-scope';
    result.reason = !first || !last ? 'single_observation_without_scope_reference' : ancestors.has(pid) ? 'finite_pid_birth_executable_ancestor_chain' : 'observed_executable_and_arguments_outside_scope';
  }
  if (!records.some(row => row.classification === 'self')) errors.push('current_process_not_bound');
  const counts: Record<Classification, number> = { self: 0, 'non-executing': 0, consumer: 0, writer: 0, unknown: 0, 'foreign-user': 0, 'foreign-user-unobservable': 0, ancestor: 0, transient: 0, 'outside-observed-scope': 0, 'same-uid-unresolvable-image': 0 };
  for (const row of records) {
    counts[row.classification]++;
    if (row.classification === 'writer') row.resolution = { action: 'finish-npm-operation', instruction: `Let the npm operation in PID ${row.pid} finish, then obtain a fresh plan and retry. Do not remove its lock.` };
    else if (row.classification === 'consumer' || row.reason === 'scope_literal_outside_bound_script') row.resolution = { action: 'close-process', instruction: `Save work and normally close the application owning PID ${row.pid}, then obtain a fresh plan and retry. Recheck PID and birth before any process operation.` };
    else if (row.classification === 'unknown') row.resolution = { action: 'unresolved', instruction: 'No approved nonprivileged resolution is established for this observation. Migration on this host is incomplete; waiting or rerunning is not a demonstrated remedy.' };
  }
  const consumers = counts.consumer, writers = counts.writer, unknown = counts.unknown;
  return { schema: 'caveat.global_process_preflight.v1' as const,
    status: errors.length || consumers || writers || unknown ? 'stopped' as const : 'ready' as const,
    observedAt: new Date().toISOString(), consumers, writers, unknown, counts, errors, records, unresolvedStops: records.filter(row => row.resolution?.action === 'unresolved').length + errors.length, confirmedExitedDuringRead: tables.confirmedExitedDuringRead ?? 0,
    protectedObjectObservation: protection ? { status: 'confirmed' as const, objects: protection.objects.length, absent: protection.absent.length, postMutation: protection.postMutation } : { status: 'not-supplied' as const },
    stopScope: { oldPackage: !!scope.packageRoot, npm: !!scope.npmRoot, aliases: scope.binAliases.length, protectedPaths: scope.protectedPaths?.length ?? 0,
      retainedPaths: retainedRoots.length, readOnlyRuntimePathsExcluded: (scope.runtimeExecutables ?? []).every(path => !(scope.protectedPaths ?? []).some(protectedPath => norm(protectedPath) === norm(path))), runtimeProofRequiredAtEveryMutation: true },
    residualRisks: globalProcessResidualRisks,
    existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
}

/** Collection injection is for core fixtures; the CLI exposes no replacement collector. */
export async function preflightGlobalProcesses(scope: GlobalProcessScope, onEvent: (event: ProcessProbeEvent) => void = () => {}, collect = nativeGlobalProcessTables) {
  validateScope(scope);
  let tables: NativeProcessTables, protection: GlobalProcessProtection | undefined;
  let collectionStage: 'protection-before' | 'collection' | 'protection-after' = 'protection-before';
  try {
    protection = scope.protection ? structuredClone(scope.protection()) : undefined;
    if (protection) validateProtection(scope, protection);
    collectionStage = 'collection'; tables = await collect(onEvent);
    collectionStage = 'protection-after';
    if (protection) assert.deepEqual(scope.protection!(), protection, 'process_protected_objects_changed');
  }
  catch (error) {
    return { schema: 'caveat.global_process_preflight.v1' as const, status: 'stopped' as const,
      observedAt: new Date().toISOString(), consumers: null, writers: null, unknown: null, records: [], counts: null, residualRisks: globalProcessResidualRisks,
      errors: [collectionStage === 'collection' ? 'native_process_collection_unconfirmed' : 'protected_objects_observation_unconfirmed'], unresolvedStops: 1,
      resolution: { action: 'unresolved' as const, instruction: 'Keep the confirmed journal and original objects. Diagnose the failed observation before retrying; no automatic repair or successful retry is established.' },
      protectionFailure: collectionStage === 'collection' ? null : { readOnly: !!(error as { readOnlyCheckFailed?: boolean })?.readOnlyCheckFailed },
      errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'),
      ownedProbe: error instanceof Error ? (error as Error & { ownedProbe?: unknown }).ownedProbe ?? null : null,
      existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
  }
  return assessGlobalProcesses(scope, tables, protection);
}

/** Flatten identities only after the caller has independently verified the held tree. */
export function processProtectionTree(path: string, rows: { relativePath: string; identity: { dev: string; ino: string } }[], originalPath = path) {
  return rows.map(row => ({ path: row.relativePath ? join(path, row.relativePath) : path, originalPath: row.relativePath ? join(originalPath, row.relativePath) : originalPath, dev: row.identity.dev, ino: row.identity.ino }));
}
