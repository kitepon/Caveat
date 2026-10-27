import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { nativeGlobalProcessTables } from './managedProcessNative.js';
import type { NativeProcessRecord, NativeProcessTables, ProcessProbeEvent } from './managedProcessNative.js';

export type GlobalProcessScope = { packageRoot: string; npmRoot: string; binAliases: string[]; protectedPaths?: string[]; runtimeExecutables?: string[] };
type Classification = 'self' | 'non-executing' | 'consumer' | 'writer' | 'unknown' | 'other-executable';
export type GlobalProcessAssessment = { pid: number; birth: string | null; classification: Classification; reason: string; executableSha256?: string };
const normalized = (value: string, fold: boolean) => {
  const slash = value.replaceAll('\\', '/').replace(/\/$/, '');
  return fold ? slash.toLowerCase() : slash;
};
const absolute = (value: string) => value.startsWith('/') || /^[a-z]:\//i.test(value);
function validateScope(scope: GlobalProcessScope) {
  assert.ok(!scope.protectedPaths || Array.isArray(scope.protectedPaths) && scope.protectedPaths.length <= 64, 'process_protected_scope_bound');
  assert.ok(!scope.runtimeExecutables || Array.isArray(scope.runtimeExecutables) && scope.runtimeExecutables.length <= 8, 'process_runtime_scope_bound');
  const paths = [scope.packageRoot, scope.npmRoot, ...scope.binAliases, ...(scope.protectedPaths ?? []), ...(scope.runtimeExecutables ?? [])].map(value => normalized(value, false));
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
    if (next === undefined || /[\/\s'"=]/.test(next)) return true;
    offset = value.indexOf(path, offset + 1);
  }
  return false;
}

/** Only complete, unchanged executable/argv observations can be classified outside the affected package. */
export function assessGlobalProcesses(scope: GlobalProcessScope, tables: NativeProcessTables) {
  validateScope(scope);
  const fold = tables.caseInsensitive, norm = (value: string) => normalized(value, fold);
  const root = norm(scope.packageRoot), npm = norm(scope.npmRoot), aliases = scope.binAliases.map(norm);
  const within = (value: string, parent: string) => value === parent || value.startsWith(parent + '/');
  const records: GlobalProcessAssessment[] = [], errors = [...tables.errors];
  const before = new Map(tables.before.map(row => [row.pid, row])), after = new Map(tables.after.map(row => [row.pid, row]));
  if (!before.size || !after.size || before.size !== tables.before.length || after.size !== tables.after.length) errors.push('process_table_empty_or_duplicate');
  for (const pid of new Set([...before.keys(), ...after.keys()])) {
    const first = before.get(pid), last = after.get(pid), row = first ?? last!;
    const result: GlobalProcessAssessment = { pid, birth: row.birth, classification: 'unknown', reason: 'process_identity_unverified' };
    records.push(result);
    const stable = (value: NativeProcessRecord) => ({ ...value, state: value.state === 'Z' ? 'Z' : 'live' });
    if (!first || !last || !isDeepStrictEqual(stable(first), stable(last))) { result.reason = 'process_appeared_disappeared_or_changed'; continue; }
    if (row.reason || !row.birth || row.ppid === null) { result.reason = row.reason ?? 'process_birth_or_parent_missing'; continue; }
    if (first.state === 'Z' && last.state === 'Z') {
      result.classification = 'non-executing'; result.reason = 'same_birth_kernel_zombie'; continue;
    }
    if (!row.executable || !row.argv || !absolute(norm(row.executable.path)) || !/^\d+$/.test(row.executable.dev) || !/^[1-9]\d*$/.test(row.executable.ino)) {
      result.reason = 'process_executable_or_arguments_missing'; continue;
    }
    result.executableSha256 = createHash('sha256').update(JSON.stringify(row.executable)).digest('hex');
    const image = norm(row.executable.path), args = (row.argv ?? []).map(norm);
    const isNode = /(?:^|\/)(?:node|nodejs)(?:\.exe)?$/.test(image)
      || (scope.runtimeExecutables ?? []).some(path => norm(path) === image)
      || row.executable.dev === tables.selfExecutable.dev && row.executable.ino === tables.selfExecutable.ino;
    const script = isNode && row.argv ? nodeScript(args) : null;
    if (within(image, npm) || script && within(script, npm)) {
      result.classification = 'writer'; result.reason = 'bound_npm_executable_or_script'; continue;
    }
    if (within(image, root) || script && (within(script, root) || aliases.includes(script))) {
      result.classification = 'consumer'; result.reason = 'bound_old_executable_or_node_script'; continue;
    }
    if (pid === tables.selfPid) {
      if (row.executable.dev === tables.selfExecutable.dev && row.executable.ino === tables.selfExecutable.ino && norm(row.executable.path) === norm(tables.selfExecutable.path)) {
        result.classification = 'self'; result.reason = 'current_pid_and_kernel_executable_bound';
      } else result.reason = 'current_process_binding_changed';
      continue;
    }
    if (args.some(value => [root, npm, ...aliases, ...(scope.protectedPaths ?? []).map(norm)].some(path => hasLiteral(value, path)))) {
      result.reason = 'scope_literal_outside_bound_script'; continue;
    }
    // Unknown JS or inline code may import the old global after this observation.
    if (isNode || /(?:^|\/)(?:bun|deno|electron|python[\d.]*|ruby[\d.]*|perl[\d.]*|php[\d.]*|java|pwsh|powershell|cmd|sh|bash|zsh|fish|dash|ksh|csh|tcsh)(?:\.exe)?$/.test(image) || args.some(arg => /^(?:-e|--eval|-p|--print|-c|--command)(?:=|$)/.test(arg))) {
      result.reason = 'unclassified_runtime_or_inline_code'; continue;
    }
    result.classification = 'other-executable'; result.reason = 'stable_kernel_executable_outside_scope';
  }
  if (!records.some(row => row.classification === 'self')) errors.push('current_process_not_bound');
  const consumers = records.filter(row => row.classification === 'consumer').length;
  const writers = records.filter(row => row.classification === 'writer').length;
  const unknown = records.filter(row => row.classification === 'unknown').length;
  return { schema: 'caveat.global_process_preflight.v1' as const,
    status: errors.length || consumers || writers || unknown ? 'stopped' as const : 'ready' as const,
    observedAt: new Date().toISOString(), consumers, writers, unknown, errors, records,
    existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
}

/** Collection injection is for core fixtures; the CLI exposes no replacement collector. */
export async function preflightGlobalProcesses(scope: GlobalProcessScope, onEvent: (event: ProcessProbeEvent) => void = () => {}, collect = nativeGlobalProcessTables) {
  validateScope(scope);
  let tables: NativeProcessTables;
  try { tables = await collect(onEvent); }
  catch (error) {
    return { schema: 'caveat.global_process_preflight.v1' as const, status: 'stopped' as const,
      observedAt: new Date().toISOString(), consumers: null, writers: null, unknown: null, records: [],
      errors: ['native_process_collection_unconfirmed'],
      errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'),
      ownedProbe: error instanceof Error ? (error as Error & { ownedProbe?: unknown }).ownedProbe ?? null : null,
      existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
  }
  return assessGlobalProcesses(scope, tables);
}
