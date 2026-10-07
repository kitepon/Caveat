import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  acquireFileLock,
  acquireReindexLock,
  computeEntriesDigest,
  reindexAllSources,
  releaseFileLock,
  writeDigestMarker,
} from './autoReindex.js';
import { communityPull } from './community.js';
import type { Logger } from './db.js';
import { openDb } from './db.js';
import { BACKGROUND_GIT_TIMEOUT_MS } from './gitRuntime.js';
import { appendGlobalPendingReminder } from './pendingReminders.js';
import type { ResolvedPaths } from './paths.js';
import {
  PROBE_REQUEST_FAILED_REASON,
  probeAnonymousRead,
  type RemoteAccess,
} from './remoteVisibility.js';
import { createKeyserverKeyProvider } from './sealedKeys.js';
import { prewarmSealedKeys } from './sealedIndex.js';
import { SyncError, SyncRemoteError, SyncRecoveryError, syncOwn } from './sync.js';

// Knowledge is worthless to the other terminals until it reaches the private
// remote, so the periodic cycle runs on a human-scale interval. A cycle is one
// probe + fetch/rebase + push against a repo that is usually unchanged.
export const AUTO_SYNC_DEBOUNCE_MS = 15 * 60 * 1000;
// A fresh entry should leave the machine without waiting for the next Stop
// hook. This floor only batches a burst of writes; it is not a rate limit.
export const AUTO_SYNC_RECORD_DEBOUNCE_MS = 60 * 1000;
export const AUTO_SYNC_SUSPEND_THRESHOLD = 3;
// After the threshold, auto-retry backs off instead of stopping forever: a
// remote that is down, rotated, or mid-conflict usually recovers without the
// user ever running a manual sync.
export const AUTO_SYNC_DEGRADED_RETRY_MS = 6 * 60 * 60 * 1000;
// A degraded sync must never rot silently, so the notice repeats on this
// interval even when the outcome has not changed.
export const AUTO_SYNC_NOTICE_REPEAT_MS = 24 * 60 * 60 * 1000;
export const CAVEAT_AUTO_SYNC_ENV = 'CAVEAT_AUTO_SYNC';
export const CAVEAT_AUTO_SYNC_DEBOUNCE_ENV = 'CAVEAT_AUTO_SYNC_DEBOUNCE_MS';

function syncDir(caveatHome: string): string {
  return join(caveatHome, 'sync');
}

export function autoSyncStatePath(caveatHome: string): string {
  return join(syncDir(caveatHome), '.last-autosync.json');
}

export function autoSyncLockPath(caveatHome: string): string {
  return join(syncDir(caveatHome), '.autosync-lock');
}

export interface AutoSyncState {
  finishedAt: string;
  signature: string;
  /** When the user was last told about a degraded sync. Drives notice repeats. */
  lastNotifiedAt?: string;
  ownSync: {
    consecutiveFailureSignature: string | null;
    consecutiveFailureCount: number;
    /** When own sync was last actually attempted. Drives the degraded backoff. */
    lastAttemptAt?: string;
  };
}

export function readAutoSyncState(caveatHome: string): AutoSyncState | null {
  try {
    const value = JSON.parse(readFileSync(autoSyncStatePath(caveatHome), 'utf-8')) as unknown;
    if (!isAutoSyncState(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeAutoSyncState(caveatHome: string, state: AutoSyncState): void {
  const dir = syncDir(caveatHome);
  mkdirSync(dir, { recursive: true });
  const path = autoSyncStatePath(caveatHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), 'utf-8');
  renameSync(temporary, path);
}

export function resetAutoSyncFailureState(caveatHome: string): void {
  try {
    const current = readAutoSyncState(caveatHome);
    writeAutoSyncState(caveatHome, {
      finishedAt: current?.finishedAt ?? new Date(0).toISOString(),
      signature: current?.signature ?? '',
      lastNotifiedAt: current?.lastNotifiedAt,
      ownSync: { consecutiveFailureSignature: null, consecutiveFailureCount: 0 },
    });
  } catch {
    // Manual sync must not fail because the autosync marker could not be reset.
  }
}

function isAutoSyncState(value: unknown): value is AutoSyncState {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as AutoSyncState;
  return (
    typeof candidate.finishedAt === 'string' &&
    typeof candidate.signature === 'string' &&
    isOptionalString(candidate.lastNotifiedAt) &&
    candidate.ownSync !== null &&
    typeof candidate.ownSync === 'object' &&
    (
      candidate.ownSync.consecutiveFailureSignature === null ||
      typeof candidate.ownSync.consecutiveFailureSignature === 'string'
    ) &&
    Number.isInteger(candidate.ownSync.consecutiveFailureCount) &&
    candidate.ownSync.consecutiveFailureCount >= 0 &&
    isOptionalString(candidate.ownSync.lastAttemptAt)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Unparseable or absent timestamps read as "never", which lets work proceed. */
function parseTimestamp(value: string | undefined): number {
  if (value === undefined) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export type OwnSyncDisposition = 'success' | 'skip' | 'network-skip' | 'fail';

export function classifyOwnSyncOutcome(
  err: unknown,
  lastProbe: RemoteAccess | undefined,
): Exclude<OwnSyncDisposition, 'success'> {
  if (!(err instanceof SyncError)) return 'fail';
  switch (err.code) {
    case 'NOT_A_REPO':
    case 'NO_REMOTE':
    case 'EXTERNAL_TOPLEVEL':
    case 'DETACHED_HEAD':
    case 'OWN_REPO_EXISTS':
    case 'BOTH_HAVE_ENTRIES':
      return 'skip';
    case 'REMOTE_PUBLIC':
    case 'SYNC_CONFLICT':
    case 'REBASE_IN_PROGRESS':
      return 'fail';
    case 'REMOTE_VISIBILITY_INDETERMINATE':
      return lastProbe?.kind === 'indeterminate' && lastProbe.reason === PROBE_REQUEST_FAILED_REASON
        ? 'network-skip'
        : 'fail';
  }
}

function syncFailureCode(err: unknown): string {
  if (err instanceof SyncError) return err.code;
  if (err instanceof SyncRemoteError) return `REMOTE_${err.phase.toUpperCase()}_FAILED`;
  if (err instanceof SyncRecoveryError) return 'RECOVERY_FAILED';
  return 'UNKNOWN';
}

export function ownSyncFailureSignature(err: unknown): string {
  // Code-only on purpose. SyncError messages for SYNC_CONFLICT embed raw git
  // rebase output (commit shas, changing file lists) that varies run to run;
  // hashing the message would mint a fresh signature every cycle, so the
  // consecutive-failure counter would never reach the suspend threshold on a
  // *persistent* conflict — exactly when E-5's escape hatch must fire.
  const code = syncFailureCode(err);
  return sha256(code);
}

export interface AutoSyncOutcome {
  community: { handle: string; status: 'ok' | 'failed'; message?: string }[];
  own: {
    disposition: OwnSyncDisposition;
    code?: string;
    pulled?: boolean;
    changedFiles?: number;
    suspended?: boolean;
    escalated?: boolean;
    /** Repeated failures have pushed own sync onto the backoff schedule. */
    degraded?: boolean;
  };
}

export function autoSyncNotification(outcome: AutoSyncOutcome): { signature: string; text: string | null } {
  const lines: string[] = [];
  if (outcome.own.pulled === true) {
    lines.push('autosync: pulled updates from your private remote');
  }
  const backoffHours = Math.round(AUTO_SYNC_DEGRADED_RETRY_MS / (60 * 60 * 1000));
  if (outcome.own.degraded === true) {
    // One wording for the whole degraded stretch, whether this cycle retried
    // and failed or sat inside the backoff. Otherwise the two states alternate
    // and every backoff window announces itself twice.
    lines.push(`autosync: own sync keeps failing; auto-retry is backed off to every ${backoffHours}h. run \`caveat sync\` to resolve now.`);
  } else if (outcome.own.disposition === 'fail') {
    lines.push(`autosync: own sync failed (${outcome.own.code ?? 'UNKNOWN'}). run \`caveat sync\` to resolve.`);
  }
  const failedHandles = outcome.community
    .filter((result) => result.status === 'failed')
    .map((result) => result.handle)
    .sort();
  if (failedHandles.length > 0) {
    lines.push(`autosync: community pull failed: ${failedHandles.join(', ')}`);
  }
  const text = lines.length > 0 ? lines.join('\n') : null;
  // The signature answers exactly one question — "has the message the user
  // would read changed?" — so it is derived from the message and nothing else.
  // Folding internal fields in here made identical messages look different and
  // re-notified on every disposition flip.
  const signature = sha256(JSON.stringify(lines));
  return { signature, text };
}

export interface RunAutoSyncOptions {
  caveatHome: string;
  ownDir: string;
  paths: Pick<ResolvedPaths, 'dbPath' | 'entriesDir' | 'communityDir'>;
  logger: Logger;
  now?: () => Date;
  gitTimeoutMs?: number;
}

export interface RunAutoSyncResult {
  ran: boolean;
  outcome?: AutoSyncOutcome;
  notified?: boolean;
}

export async function runAutoSync(opts: RunAutoSyncOptions): Promise<RunAutoSyncResult> {
  if (process.env[CAVEAT_AUTO_SYNC_ENV] === 'off') return { ran: false };
  const lock = acquireFileLock(autoSyncLockPath(opts.caveatHome));
  if (!lock) return { ran: false };

  let reindexLock: ReturnType<typeof acquireReindexLock> = null;
  try {
    // Take the reindex lock up front and hold it across the whole cycle so
    // syncOwn's internal (lock-less) reindex is serialized against the
    // standalone reindex worker (E-4). If a reindex is already running, bail
    // WITHOUT writing state: leaving the debounce clock untouched makes the
    // next stop retry promptly instead of silently deferring the push for up
    // to a full debounce window.
    reindexLock = acquireReindexLock(opts.caveatHome);
    if (!reindexLock) return { ran: false };

    const nowDate = (opts.now ?? (() => new Date()))();
    const nowMs = nowDate.getTime();
    const nowIso = nowDate.toISOString();
    const previousState = readAutoSyncState(opts.caveatHome);
    let ownSyncState = previousState?.ownSync ?? {
      consecutiveFailureSignature: null,
      consecutiveFailureCount: 0,
    };
    const community = await communityPull({
      communityDir: opts.paths.communityDir,
      logger: opts.logger,
      gitTimeoutMs: opts.gitTimeoutMs ?? BACKGROUND_GIT_TIMEOUT_MS,
    });

    let own: AutoSyncOutcome['own'];
    // E-5: after repeated same-code failures auto-retry backs off, but it does
    // not stop. A permanent stop that only a manual `caveat sync` could clear
    // left propagation dead until the user happened to notice.
    const degraded = ownSyncState.consecutiveFailureCount >= AUTO_SYNC_SUSPEND_THRESHOLD;
    const retryDue =
      nowMs - parseTimestamp(ownSyncState.lastAttemptAt) >= AUTO_SYNC_DEGRADED_RETRY_MS;
    if (degraded && !retryDue) {
      own = { disposition: 'skip', suspended: true };
    } else {
      ownSyncState = { ...ownSyncState, lastAttemptAt: nowIso };
      let lastProbe: RemoteAccess | undefined;
      try {
        const result = await syncOwn({
          ownDir: opts.ownDir,
          caveatHome: opts.caveatHome,
          paths: opts.paths,
          logger: opts.logger,
          trustRemotePrivate: false,
          gitTimeoutMs: opts.gitTimeoutMs ?? BACKGROUND_GIT_TIMEOUT_MS,
          probeImpl: async (url) => {
            const probe = await probeAnonymousRead(url);
            lastProbe = probe;
            return probe;
          },
        });
        own = {
          disposition: 'success',
          pulled: result.pulled,
          changedFiles: result.changedFiles,
        };
        ownSyncState = { consecutiveFailureSignature: null, consecutiveFailureCount: 0 };
      } catch (err: unknown) {
        const disposition = classifyOwnSyncOutcome(err, lastProbe);
        const code = syncFailureCode(err);
        own = { disposition, code: code === 'UNKNOWN' ? undefined : code };
        if (disposition === 'fail') {
          const failureSignature = ownSyncFailureSignature(err);
          const consecutiveFailureCount =
            ownSyncState.consecutiveFailureSignature === failureSignature
              ? ownSyncState.consecutiveFailureCount + 1
              : 1;
          ownSyncState = {
            consecutiveFailureSignature: failureSignature,
            consecutiveFailureCount,
            lastAttemptAt: nowIso,
          };
          if (consecutiveFailureCount === AUTO_SYNC_SUSPEND_THRESHOLD) own.escalated = true;
        }
      }
    }

    if (ownSyncState.consecutiveFailureCount >= AUTO_SYNC_SUSPEND_THRESHOLD) own.degraded = true;

    // Reindex under the held lock so community-pull changes land in the index
    // even when own sync was skipped or failed.
    await reindexAndMark(opts);

    const outcome: AutoSyncOutcome = { community, own };
    const { signature, text } = autoSyncNotification(outcome);
    // A changed message always speaks. A *degraded* sync also re-speaks on an
    // interval: signature dedup alone announced the breakage once and then went
    // quiet forever while nothing propagated.
    const repeatDue =
      own.degraded === true &&
      nowMs - parseTimestamp(previousState?.lastNotifiedAt) >= AUTO_SYNC_NOTICE_REPEAT_MS;
    let notified = false;
    if (text !== null && (previousState?.signature !== signature || repeatDue)) {
      appendGlobalPendingReminder(opts.caveatHome, text);
      notified = true;
    }
    writeAutoSyncState(opts.caveatHome, {
      finishedAt: nowIso,
      signature,
      lastNotifiedAt: notified ? nowIso : previousState?.lastNotifiedAt,
      ownSync: ownSyncState,
    });
    return { ran: true, outcome, notified };
  } catch (err: unknown) {
    opts.logger.warn(`autosync failed: ${errorMessage(err)}`);
    return { ran: true };
  } finally {
    if (reindexLock) {
      try {
        releaseFileLock(reindexLock);
      } catch (err: unknown) {
        opts.logger.warn(`autosync reindex lock release failed: ${errorMessage(err)}`);
      }
    }
    try {
      releaseFileLock(lock);
    } catch (err: unknown) {
      opts.logger.warn(`autosync lock release failed: ${errorMessage(err)}`);
    }
  }
}

export interface TriggerAutoSyncOptions {
  caveatHome: string;
  /** Caveat CLI entry script; the worker is spawned as `<cliScript> hook autosync`. */
  cliScript: string;
  /** Minimum age of the last completed cycle before spawning. Default: AUTO_SYNC_DEBOUNCE_MS. */
  debounceMs?: number;
}

/**
 * Spawn a detached autosync worker unless one ran recently. Returns immediately;
 * the worker owns the real lock, so an over-eager caller costs a wasted spawn,
 * never a concurrent sync.
 */
export function triggerAutoSync(opts: TriggerAutoSyncOptions): void {
  if (process.env[CAVEAT_AUTO_SYNC_ENV] === 'off') return;
  const debounceMs = resolveTriggerDebounceMs(opts.debounceMs ?? AUTO_SYNC_DEBOUNCE_MS);
  const statePath = autoSyncStatePath(opts.caveatHome);
  try {
    if (existsSync(statePath) && Date.now() - statSync(statePath).mtimeMs < debounceMs) return;
  } catch {
    // Treat unreadable state as not yet run; the worker owns the real lock.
  }
  if (!opts.cliScript) throw new Error('current Caveat CLI script path is unavailable');
  const child = spawn(
    process.execPath,
    [...process.execArgv, '--disable-warning=ExperimentalWarning', opts.cliScript, 'hook', 'autosync'],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}

function resolveTriggerDebounceMs(fallback: number): number {
  const raw = process.env[CAVEAT_AUTO_SYNC_DEBOUNCE_ENV];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    // A malformed override used to read as NaN, and `elapsed < NaN` is false —
    // so garbage here silently meant "spawn a worker on every trigger".
    process.stderr.write(
      `[caveat] ${CAVEAT_AUTO_SYNC_DEBOUNCE_ENV}=${raw} is not a non-negative number; using ${fallback}ms\n`,
    );
    return fallback;
  }
  return parsed;
}

async function reindexAndMark(opts: RunAutoSyncOptions): Promise<void> {
  const keyProvider = createKeyserverKeyProvider({ caveatHome: opts.caveatHome });
  const failures = await prewarmSealedKeys({ paths: opts.paths, keyProvider });
  for (const failure of failures) {
    opts.logger.warn(`${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}`);
  }
  mkdirSync(dirname(opts.paths.dbPath), { recursive: true });
  const db = openDb({ path: opts.paths.dbPath, logger: opts.logger });
  try {
    reindexAllSources({ db, paths: opts.paths, logger: opts.logger, keyProvider });
    writeDigestMarker(opts.caveatHome, computeEntriesDigest(opts.paths));
  } finally {
    db.close();
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
