import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireFileLock, releaseFileLock } from './autoReindex.js';
import { AUTO_SYNC_DEBOUNCE_MS, runAutoSync, type RunAutoSyncOptions, type RunAutoSyncResult } from './autoSync.js';

export interface PeriodicSyncResult {
  schema: 'caveat.periodic_sync.v1';
  status: 'success' | 'skipped' | 'failed';
  reason: string;
  started_at: string;
  finished_at: string;
}

export interface PeriodicSyncState {
  schema: 'caveat.periodic_sync_state.v1';
  last_result: PeriodicSyncResult;
  last_attempt: PeriodicSyncResult | null;
  last_success_at: string | null;
  last_failure: PeriodicSyncResult | null;
}

const statePath = (home: string) => join(home, 'sync', '.periodic-sync.json');

export function readPeriodicSyncState(home: string): PeriodicSyncState | null {
  try {
    const value = JSON.parse(readFileSync(statePath(home), 'utf8')) as PeriodicSyncState;
    const validTime = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
    const validResult = (x: unknown): x is PeriodicSyncResult => {
      if (!x || typeof x !== 'object') return false;
      const row = x as PeriodicSyncResult;
      return row.schema === 'caveat.periodic_sync.v1' && ['success', 'skipped', 'failed'].includes(row.status)
        && typeof row.reason === 'string' && /^[a-z_]{1,64}$/.test(row.reason)
        && validTime(row.started_at) && validTime(row.finished_at);
    };
    if (value?.schema !== 'caveat.periodic_sync_state.v1' || !validResult(value.last_result)
      || (value.last_attempt !== null && !validResult(value.last_attempt))
      || (value.last_failure !== null && !validResult(value.last_failure))
      || (value.last_success_at !== null && !validTime(value.last_success_at))) return null;
    // Return only the public contract; an extra field in a local file must not
    // accidentally expose arbitrary data through `autosync status`.
    const result = (row: PeriodicSyncResult | null): PeriodicSyncResult | null => row && ({
      schema: row.schema, status: row.status, reason: row.reason, started_at: row.started_at, finished_at: row.finished_at,
    });
    return { schema: value.schema, last_result: result(value.last_result)!, last_attempt: result(value.last_attempt),
      last_success_at: value.last_success_at, last_failure: result(value.last_failure) };
  } catch { return null; }
}

function disposition(cycle: RunAutoSyncResult): Pick<PeriodicSyncResult, 'status' | 'reason'> {
  if (!cycle.ran) return { status: 'skipped', reason: cycle.skipReason ?? 'not_run' };
  if (cycle.errorCode || !cycle.outcome) return { status: 'failed', reason: cycle.errorCode ?? 'cycle_failed' };
  const { own, community } = cycle.outcome;
  // A failure in a subscribed source must not become success just because own
  // sync succeeded. Current retries/backoff remain owned by runAutoSync.
  if (community.some(row => row.status === 'failed')) return { status: 'failed', reason: 'community_failed' };
  if (own.disposition === 'success') return { status: 'success', reason: 'synced_and_indexed' };
  if (own.suspended) return { status: 'skipped', reason: 'degraded_wait' };
  if (own.disposition === 'skip') return { status: 'skipped', reason: own.code?.toLowerCase() ?? 'own_skipped' };
  return { status: 'failed', reason: own.code?.toLowerCase() ?? 'own_sync_failed' };
}

export async function runPeriodicSync(
  opts: Omit<RunAutoSyncOptions, 'dirtyPolicy' | 'debounceMs'> & { intervalMs?: number },
): Promise<PeriodicSyncResult> {
  const interval = opts.intervalMs ?? AUTO_SYNC_DEBOUNCE_MS;
  if (!Number.isFinite(interval) || interval < 0) throw Error('periodic_sync_interval_invalid');
  const clock = opts.now ?? (() => new Date());
  const started_at = clock().toISOString();
  const lock = acquireFileLock(join(opts.caveatHome, 'sync', '.periodic-sync-lock'));
  if (!lock) return { schema: 'caveat.periodic_sync.v1', status: 'skipped', reason: 'periodic_busy', started_at, finished_at: clock().toISOString() };
  try {
    const previous = readPeriodicSyncState(opts.caveatHome);
    const cycle = await runAutoSync({ ...opts, dirtyPolicy: 'refuse', debounceMs: interval });
    const result: PeriodicSyncResult = { schema: 'caveat.periodic_sync.v1', ...disposition(cycle), started_at, finished_at: clock().toISOString() };
    const state: PeriodicSyncState = {
      schema: 'caveat.periodic_sync_state.v1',
      last_result: result,
      last_attempt: cycle.ran ? result : previous?.last_attempt ?? null,
      last_success_at: result.status === 'success' ? result.finished_at : previous?.last_success_at ?? null,
      last_failure: result.status === 'failed' ? result : previous?.last_failure ?? null,
    };
    mkdirSync(join(opts.caveatHome, 'sync'), { recursive: true });
    const temporary = `${statePath(opts.caveatHome)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, statePath(opts.caveatHome));
    return result;
  } finally { releaseFileLock(lock); }
}
