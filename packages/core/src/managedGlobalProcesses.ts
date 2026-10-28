import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMacForeignArgumentDenial, nativeGlobalProcessTables } from './managedProcessNative.js';
import type { NativeProcessRecord, NativeProcessTables, ProcessProbeEvent } from './managedProcessNative.js';

export type GlobalProcessScope = { packageRoot?: string; npmRoot?: string; binAliases: string[]; protectedPaths?: string[]; runtimeExecutables?: string[] };
type Classification = 'self' | 'non-executing' | 'consumer' | 'writer' | 'unknown' | 'foreign-user' | 'foreign-user-unobservable' | 'ancestor' | 'transient' | 'outside-observed-scope';
export type GlobalProcessAssessment = { pid: number; birth: string | null; classification: Classification; reason: string; executableSha256?: string; imageDeleted?: boolean; runtime?: boolean; observation?: { owner: 'same' | 'foreign' | 'unknown'; missing: string[]; nativeIssues: string[] } };
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
  const paths = [...(scope.packageRoot === undefined ? [] : [scope.packageRoot, scope.npmRoot!]), ...scope.binAliases, ...(scope.protectedPaths ?? []), ...(scope.runtimeExecutables ?? [])].map(value => normalized(value, false));
  assert.ok(paths.every(value => absolute(value) && value.length > 1 && !/[\x00-\x1f]/.test(value) && !value.split('/').some(part => part === '.' || part === '..')), 'absolute_process_scope_required');
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
  'a later import may fail after the old global is retained in quarantine; existing data is never overwritten',
  'foreign-user non-runtime processes with OS-restricted argv may already use or write the old global; root or administrator exclusivity is not proven',
] as const;

/** Observation scope is explicit; outside-scope classification is not proof against future dynamic imports. */
export function assessGlobalProcesses(scope: GlobalProcessScope, tables: NativeProcessTables) {
  validateScope(scope);
  const fold = tables.caseInsensitive, norm = (value: string) => normalized(value, fold);
  const root = scope.packageRoot === undefined ? null : norm(scope.packageRoot), npm = scope.npmRoot === undefined ? null : norm(scope.npmRoot), aliases = scope.binAliases.map(norm);
  const paths = [...(root ? [root] : []), ...(npm ? [npm] : []), ...aliases, ...(scope.protectedPaths ?? []).map(norm)];
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
      nativeIssues: [...new Set(observed.flatMap(row => [row.argumentFailure ? 'darwin-argv:' + row.argumentFailure.stage + ':' + row.argumentFailure.nativeCode + (row.argumentFailure.decodeReason ? ':' + row.argumentFailure.decodeReason : '') + (row.argumentFailure.decodePosition ? ':' + row.argumentFailure.decodePosition : '') : null,
        row.ownerFailure ? 'windows-owner:' + row.ownerFailure.stage + ':' + row.ownerFailure.nativeCode : null,
        row.ownerMethod ? 'windows-owner-method:' + row.ownerMethod.stage + ':' + row.ownerMethod.returnValue : null,
        row.kernelFailure ? 'darwin-kernel:' + row.kernelFailure.stage + ':' + row.kernelFailure.nativeCode : null,
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
    const bound = (entry: NativeProcessRecord) => {
      const path = entry.executable ? norm(entry.executable.path).replace(/ \(deleted\)$/, '') : null;
      const argv = entry.argv?.map(norm);
      const node = !!path && (/(?:^|\/)(?:node|nodejs)(?:\.exe)?$/.test(path)
        || (scope.runtimeExecutables ?? []).some(value => norm(value) === path)
        || entry.executable?.dev === tables.selfExecutable.dev && entry.executable?.ino === tables.selfExecutable.ino);
      const candidate = node && argv ? nodeScript(argv) : null;
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
      if (isRuntime) { result.reason = 'foreign_runtime_arguments_unavailable'; continue; }
      result.classification = 'foreign-user-unobservable'; result.reason = 'darwin_foreign_uid_bound_image_einval'; continue;
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
  const counts: Record<Classification, number> = { self: 0, 'non-executing': 0, consumer: 0, writer: 0, unknown: 0, 'foreign-user': 0, 'foreign-user-unobservable': 0, ancestor: 0, transient: 0, 'outside-observed-scope': 0 };
  for (const row of records) counts[row.classification]++;
  const consumers = counts.consumer, writers = counts.writer, unknown = counts.unknown;
  return { schema: 'caveat.global_process_preflight.v1' as const,
    status: errors.length || consumers || writers || unknown ? 'stopped' as const : 'ready' as const,
    observedAt: new Date().toISOString(), consumers, writers, unknown, counts, errors, records, confirmedExitedDuringRead: tables.confirmedExitedDuringRead ?? 0,
    stopScope: { oldPackage: !!scope.packageRoot, npm: !!scope.npmRoot, aliases: scope.binAliases.length, protectedPaths: scope.protectedPaths?.length ?? 0,
      readOnlyRuntimePathsExcluded: (scope.runtimeExecutables ?? []).every(path => !(scope.protectedPaths ?? []).some(protectedPath => norm(protectedPath) === norm(path))), runtimeProofRequiredAtEveryMutation: true },
    residualRisks: globalProcessResidualRisks,
    existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
}

/** Collection injection is for core fixtures; the CLI exposes no replacement collector. */
export async function preflightGlobalProcesses(scope: GlobalProcessScope, onEvent: (event: ProcessProbeEvent) => void = () => {}, collect = nativeGlobalProcessTables) {
  validateScope(scope);
  let tables: NativeProcessTables;
  try { tables = await collect(onEvent); }
  catch (error) {
    return { schema: 'caveat.global_process_preflight.v1' as const, status: 'stopped' as const,
      observedAt: new Date().toISOString(), consumers: null, writers: null, unknown: null, records: [], counts: null, residualRisks: globalProcessResidualRisks,
      errors: ['native_process_collection_unconfirmed'],
      errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'),
      ownedProbe: error instanceof Error ? (error as Error & { ownedProbe?: unknown }).ownedProbe ?? null : null,
      existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
  }
  return assessGlobalProcesses(scope, tables);
}
