import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireFileLock, releaseFileLock } from './autoReindex.js';
import { nativeSchedulePresent, nativeScheduleReadbackMatches, nativeScheduleCanRecover, nativeSyncSchedule, type NativeSyncSchedule, type NativeSyncScheduleOptions, type ScheduleCommand } from './platform.js';

export type ScheduleRunner = (command: ScheduleCommand) => { status: number; stdout: string };
export interface SyncScheduleState {
  schema: 'caveat.sync_schedule.v1'; id: string; kind: NativeSyncSchedule['kind'];
  file_hashes: Record<string, string>; registered: boolean;
  last_operation: string; last_failure: string | null; definition: NativeSyncSchedule;
}
export interface SyncScheduleOptions extends NativeSyncScheduleOptions { dryRun?: boolean; runner?: ScheduleRunner }
export interface SyncScheduleResult {
  schema: 'caveat.sync_schedule_result.v1'; status: 'success' | 'failed' | 'planned' | 'uninstalled';
  reason: string; definition?: NativeSyncSchedule; registered?: boolean; definition_matches?: boolean;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const statePath = (home: string) => join(home, 'sync', '.schedule.json');
const defaultRunner: ScheduleRunner = command => {
  const result = spawnSync(command.command, command.args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return { status: result.status ?? -1, stdout: result.stdout ?? '' };
};
function state(home: string): SyncScheduleState | null {
  const path = statePath(home);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('schedule_state_unsafe');
  const value = JSON.parse(readFileSync(path, 'utf8')) as SyncScheduleState;
  if (value.schema !== 'caveat.sync_schedule.v1' || !value.file_hashes || typeof value.registered !== 'boolean') throw Error('schedule_state_invalid');
  return value;
}
function save(home: string, value: SyncScheduleState): void {
  const path = statePath(home); mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path);
}
function verifyOwned(plan: NativeSyncSchedule, old: SyncScheduleState): void {
  if (old.id !== plan.id || old.kind !== plan.kind) throw Error('schedule_owner_mismatch');
  const allowed = new Set(plan.files.map(file => file.path));
  if (Object.keys(old.file_hashes).some(path => !allowed.has(path))) throw Error('schedule_owner_mismatch');
  for (const file of plan.files) {
    const expected = old.file_hashes[file.path];
    if (!expected) { if (existsSync(file.path)) throw Error('schedule_file_unmanaged'); continue; }
    if (!existsSync(file.path) || !lstatSync(file.path).isFile() || lstatSync(file.path).isSymbolicLink()
      || digest(readFileSync(file.path, 'utf8')) !== expected) throw Error('schedule_definition_changed');
  }
}
function filesMatch(plan: NativeSyncSchedule): boolean {
  return plan.files.every(file => existsSync(file.path) && lstatSync(file.path).isFile() && !lstatSync(file.path).isSymbolicLink() && readFileSync(file.path, 'utf8') === file.content);
}
function nativeReadback(plan: NativeSyncSchedule, run: ScheduleRunner, query: ScheduleCommand = plan.query): boolean {
  const result = run(query);
  if (result.status !== 0) return false;
  // Windows reads executable, arguments, trigger and execution policy from XML.
  // Other adapters check registration and the owned file definition; actual
  // native execution and session lifecycle are separate acceptance checks.
  return nativeScheduleReadbackMatches(plan, result.stdout);
}
function commands(list: ScheduleCommand[], run: ScheduleRunner): void {
  for (const command of list) if (run(command).status !== 0) throw Error('schedule_native_command_failed');
}

export function manageSyncSchedule(action: 'install' | 'status' | 'uninstall', opts: SyncScheduleOptions): SyncScheduleResult {
  const plan = nativeSyncSchedule(opts);
  if (opts.dryRun) return { schema: 'caveat.sync_schedule_result.v1', status: 'planned', reason: action, definition: plan };
  const run = opts.runner ?? defaultRunner;
  let old: SyncScheduleState | null = null;
  let owned: SyncScheduleState | null = null;
  let lock: ReturnType<typeof acquireFileLock> = null;
  try {
    old = state(opts.caveatHome);
    if (old) verifyOwned(plan, old);
    else if (plan.files.some(file => existsSync(file.path))) throw Error('schedule_file_unmanaged');
    if (action === 'status') {
      const registered = Boolean(old?.registered && nativeReadback(plan, run));
      const matches = filesMatch(plan);
      return { schema: 'caveat.sync_schedule_result.v1', status: registered && matches ? 'success' : old?.registered ? 'failed' : 'uninstalled',
        reason: old?.registered && (!registered || !matches) ? 'schedule_readback_failed' : old?.last_failure ?? 'observed', registered, definition_matches: matches };
    }
    // Do not replace or remove a job while its periodic cycle is running.
    lock = acquireFileLock(join(opts.caveatHome, 'sync', '.periodic-sync-lock'));
    if (!lock) throw Error('schedule_cycle_busy');
    old = state(opts.caveatHome);
    if (old) verifyOwned(plan, old);
    const inspection = run(plan.inspect);
    const present = nativeSchedulePresent(plan.kind, inspection.status, inspection.stdout);
    const recoverable = old && ['installing', 'failed'].includes(old.last_operation)
      && Object.keys(old.file_hashes).length === plan.files.length
      && filesMatch(old.definition)
      && nativeScheduleCanRecover(old.definition, () => nativeReadback(old!.definition, run, plan.query));
    if (present && !old?.registered && !recoverable) throw Error('schedule_job_unmanaged');
    if (present && old?.registered && !nativeReadback(old.definition, run, plan.query)) throw Error('schedule_native_changed');
    if (action === 'uninstall') {
      if (present) commands(plan.remove, run);
      if (old) {
        owned = { ...old, registered: false, last_operation: 'removing' };
        for (const file of plan.files) if (owned.file_hashes[file.path]) {
          unlinkSync(file.path); delete owned.file_hashes[file.path]; save(opts.caveatHome, owned);
        }
        commands(plan.reload, run);
        save(opts.caveatHome, { ...owned, last_operation: 'uninstalled' });
      }
      return { schema: 'caveat.sync_schedule_result.v1', status: 'uninstalled', reason: 'removed_owned_schedule', registered: false };
    }
    if (old?.registered && filesMatch(plan) && nativeReadback(plan, run)) {
      return { schema: 'caveat.sync_schedule_result.v1', status: 'success', reason: 'unchanged', registered: true, definition_matches: true };
    }
    if (present) commands(plan.remove, run);
    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, { mode: 0o600, flag: old?.file_hashes[file.path] ? 'w' : 'wx' });
    }
    owned = { schema: 'caveat.sync_schedule.v1', id: plan.id, kind: plan.kind,
      file_hashes: Object.fromEntries(plan.files.map(file => [file.path, digest(file.content)])), registered: false,
      definition: plan, last_operation: 'installing', last_failure: old?.last_failure ?? null };
    save(opts.caveatHome, owned);
    commands(plan.install, run);
    if (!filesMatch(plan) || !nativeReadback(plan, run)) throw Error('schedule_readback_failed');
    save(opts.caveatHome, { ...owned, registered: true, last_operation: 'installed' });
    return { schema: 'caveat.sync_schedule_result.v1', status: 'success', reason: 'installed_and_read_back', registered: true, definition_matches: true };
  } catch (error) {
    const reason = error instanceof Error && /^schedule_[a-z_]+$/.test(error.message) ? error.message : 'schedule_operation_failed';
    // Retain a failed registration's payload and ownership record for review;
    // never infer success or delete a possibly live native job on error.
    const record = owned ?? old;
    if (record && lock && action !== 'status' && !['schedule_definition_changed', 'schedule_owner_mismatch', 'schedule_job_unmanaged', 'schedule_file_unmanaged', 'schedule_native_changed'].includes(reason)) {
      try { save(opts.caveatHome, { ...record, last_operation: 'failed', last_failure: reason }); } catch { /* Preserve the original files. */ }
    }
    return { schema: 'caveat.sync_schedule_result.v1', status: 'failed', reason };
  } finally { if (lock) releaseFileLock(lock); }
}
