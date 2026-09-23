import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  linkSync,
  openSync,
  closeSync,
  chmodSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Per-session on-disk queue of deferred reminders. Used by the async
 * PostToolUse hook pipeline: a fast foreground hook writes request files,
 * a detached worker processes them and writes reminder files here, then
 * the next hook invocation drains the queue to stdout.
 */

function sanitizeSessionId(raw: string): string {
  // Only allow hex / dash / underscore. Prevents traversal via crafted
  // session_id values. Empty input → fallback bucket.
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.length > 0 ? clean : '_unknown';
}

export const GLOBAL_PENDING_SESSION = '_global';

// Hook commands have a five-second outer budget. Queue contention must fail
// fast enough for the adapter to emit its fixed diagnostic and retry next hook.
const PENDING_LOCK_BUSY_TIMEOUT_MS = 1_000;

/**
 * Serialize queue mutations and stale sweeping across OS processes. SQLite's
 * write lock is released by the OS when a process exits, so crash recovery does
 * not require deleting a shared lockfile (which would introduce another ABA
 * race). The transaction intentionally contains no durable application state.
 */
function withPendingQueueLock<T>(caveatHome: string, operation: () => T): T {
  const root = join(caveatHome, 'pending');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, '.queue-lock.sqlite');
  const db = new DatabaseSync(lockPath);
  let transactionOpen = false;
  try {
    chmodSync(lockPath, 0o600);
    db.exec(`PRAGMA busy_timeout = ${PENDING_LOCK_BUSY_TIMEOUT_MS}`);
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const result = operation();
    db.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch { /* close releases the OS lock */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

export function pendingDirFor(caveatHome: string, sessionId: string): string {
  return join(caveatHome, 'pending', sanitizeSessionId(sessionId));
}

export function appendPendingReminder(
  caveatHome: string,
  sessionId: string,
  text: string,
): string {
  return withPendingQueueLock(caveatHome, () => {
    const dir = pendingDirFor(caveatHome, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
    const path = join(dir, name);
    writeFileSync(path, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    return path;
  });
}

export interface PendingSemanticKeyInput {
  agent: string;
  surface: string;
  refs: ReadonlyArray<{ source: string; id: string }>;
  stopSignalDigest?: string;
}

/** Stable dedupe key; advisory outcome is intentionally not part of it. */
export function buildPendingSemanticKey(input: PendingSemanticKeyInput): string {
  const refs = [...input.refs].map(({ source, id }) => ({ source, id }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
    .filter((ref, index, all) => index === 0 || ref.source !== all[index - 1]!.source || ref.id !== all[index - 1]!.id)
    .map(({ source, id }) => [source, id]);
  return createHash('sha256').update(JSON.stringify({
    agent: input.agent, surface: input.surface, refs, stopSignalDigest: input.stopSignalDigest ?? null,
  })).digest('hex');
}

export interface PendingClaim { caveatHome: string; key: string; ownerToken: string; path: string; }
const CLAIM_TTL_MS = 5 * 60 * 1000;

function hasNonExpiredPendingClaim(sessionDir: string, nowMs: number): boolean {
  const claimsDir = join(sessionDir, '.claims');
  let claims: string[];
  try {
    claims = readdirSync(claimsDir).filter((entry) => entry.endsWith('.claim'));
  } catch (error: unknown) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
  for (const claim of claims) {
    const path = join(claimsDir, claim);
    try {
      let createdAt = statSync(path).mtimeMs;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { createdAt?: unknown };
        if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
      } catch {
        // A fresh malformed/torn claim still protects a possibly live builder.
      }
      if (nowMs - createdAt <= CLAIM_TTL_MS) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function acquirePendingClaim(
  caveatHome: string, sessionId: string, key: string, options: { now?: number; ttlMs?: number } = {},
): PendingClaim | null {
  return withPendingQueueLock(caveatHome, () => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('pending semantic key is invalid');
    if (existsSync(join(pendingDirFor(caveatHome, sessionId), `${key}.ready`))) return null;
    const dir = join(pendingDirFor(caveatHome, sessionId), '.claims');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${key}.claim`);
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs ?? CLAIM_TTL_MS;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ownerToken = randomBytes(16).toString('hex');
      try {
        const fd = openSync(path, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ ownerToken, createdAt: now }), 'utf-8'); } finally { closeSync(fd); }
        // The queue lock excludes stale-reclaim ABA. Recheck ready while still
        // holding it to close winner-publish -> contender-claim TOCTOU.
        if (existsSync(join(pendingDirFor(caveatHome, sessionId), `${key}.ready`))) {
          unlinkSync(path);
          return null;
        }
        return { caveatHome, key, ownerToken, path };
      } catch (error: unknown) {
        if (!(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error;
        try {
          let createdAt = statSync(path).mtimeMs;
          try {
            const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { createdAt?: unknown };
            if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
          } catch {
            // A torn claim is treated as stale only after its filesystem TTL.
          }
          if (now - createdAt <= ttlMs) return null;
          unlinkSync(path);
        } catch (retryError: unknown) {
          if (retryError && typeof retryError === 'object' && (retryError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          return null;
        }
      }
    }
    return null;
  });
}

export function releasePendingClaim(claim: PendingClaim): void {
  withPendingQueueLock(claim.caveatHome, () => {
    try {
      const parsed = JSON.parse(readFileSync(claim.path, 'utf-8')) as { ownerToken?: unknown };
      if (parsed.ownerToken !== claim.ownerToken) return;
      unlinkSync(claim.path);
    } catch (error: unknown) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  });
}

/** Atomically coalesces same-key publishes. Only completed `.ready` files drain. */
export function publishPendingReminder(
  caveatHome: string, sessionId: string, semanticKey: string, text: string,
): { path: string; published: boolean } {
  if (!/^[a-f0-9]{64}$/.test(semanticKey)) throw new Error('pending semantic key is invalid');
  const ready = join(pendingDirFor(caveatHome, sessionId), `${semanticKey}.ready`);
  if (existsSync(ready)) return { path: ready, published: false };
  try {
    return withPendingQueueLock(caveatHome, () => {
      const dir = pendingDirFor(caveatHome, sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = join(dir, `.${semanticKey}.${randomBytes(12).toString('hex')}.tmp`);
      writeFileSync(temp, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      try {
        linkSync(temp, ready);
        return { path: ready, published: true };
      } catch (error: unknown) {
        if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST') return { path: ready, published: false };
        throw error;
      } finally {
        try { unlinkSync(temp); } catch (error: unknown) {
          if (!(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
        }
      }
    });
  } catch (error) {
    // A same-key winner may complete while this process is bounded on the
    // queue lock. A completed immutable ready inode satisfies this publish;
    // every other lock failure remains explicit.
    if (existsSync(ready)) return { path: ready, published: false };
    throw error;
  }
}

/**
 * The sole path for work that must happen before a semantic reminder exists
 * (notably sidecar advice): claim before invoking `build`, then publish.
 */
export function buildAndPublishPendingReminder(
  caveatHome: string,
  sessionId: string,
  semanticKey: string,
  build: () => string,
): { ran: boolean; published: boolean } {
  const claim = acquirePendingClaim(caveatHome, sessionId, semanticKey);
  if (!claim) return { ran: false, published: false };
  try {
    const result = publishPendingReminder(caveatHome, sessionId, claim.key, build());
    return { ran: true, published: result.published };
  } finally {
    releasePendingClaim(claim);
  }
}

export function appendGlobalPendingReminder(caveatHome: string, text: string): string {
  return appendPendingReminder(caveatHome, GLOBAL_PENDING_SESSION, text);
}

/**
 * Read every pending reminder file for this session, unlink them, and
 * return their contents in timestamp-ascending order. Safe to call when
 * the session has no queue (returns empty array). Never throws on
 * individual file read / unlink failures — those are logged to stderr
 * by the caller's logger.
 */
/**
 * Sweep stale per-session pending directories under `<caveatHome>/pending/`.
 *
 * A subdirectory is removed (subtree-rmSync) iff every entry — the directory
 * itself and any leftover legacy `.txt`, `.ready`, or claim state — has an
 * mtime older than `staleDays`.
 * Empty husks left behind by a successful drain age out naturally because
 * their mtime stops updating once nothing writes to them. Stranded reminders
 * from sessions that ended before drain are handled the same way: once
 * `staleDays` has elapsed since the last write, the whole subtree is recycled.
 *
 * Queue mutation/drain and this scan+remove share the SQLite queue lock, so a
 * writer cannot enter the directory after the mtime snapshot and before the
 * recursive remove. Recent state also keeps an active session above the cutoff.
 */
export function cleanupStalePendingDirs(
  caveatHome: string,
  options: { staleDays?: number; now?: Date } = {},
): { removed: string[]; kept: number } {
  const staleDays = options.staleDays ?? 7;
  if (staleDays < 0) {
    throw new Error(`cleanupStalePendingDirs: staleDays must be >= 0 (got ${staleDays})`);
  }
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const root = join(caveatHome, 'pending');
  if (!existsSync(root)) return { removed: [], kept: 0 };

  return withPendingQueueLock(caveatHome, () => {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return { removed: [], kept: 0 };
    }

    const removed: string[] = [];
    let kept = 0;
    for (const entry of entries) {
      const sub = join(root, entry);
      let subStat;
      try {
        subStat = statSync(sub);
      } catch {
        continue;
      }
      if (!subStat.isDirectory()) continue;
      if (hasNonExpiredPendingClaim(sub, now.getTime())) {
        kept++;
        continue;
      }

      let newest = subStat.mtimeMs;
      let scanFailed = false;
      try {
        for (const f of readdirSync(sub)) {
          const fp = join(sub, f);
          try {
            const fileStat = statSync(fp);
            if (fileStat.mtimeMs > newest) newest = fileStat.mtimeMs;
          } catch {
            scanFailed = true;
            break;
          }
        }
      } catch {
        scanFailed = true;
      }

      if (scanFailed || newest >= cutoffMs) {
        kept++;
        continue;
      }
      try {
        rmSync(sub, { recursive: true, force: true });
        removed.push(sub);
      } catch {
        // Best-effort: leave the directory if rm fails (permission).
        kept++;
      }
    }
    return { removed, kept };
  });
}

export interface MaybeSweepResult {
  swept?: { removed: string[]; kept: number };
  skipped?: 'env_off' | 'no_pending_dir' | 'debounced';
}

/**
 * Hook-driven, debounced wrapper around `cleanupStalePendingDirs`.
 *
 * Designed to be called from the hot path (e.g. `caveat hook stop`) where
 * the same hook fires many times per session. Behavior:
 *
 *   1. If `CAVEAT_PENDING_SWEEP=off` is set, return `{ skipped: 'env_off' }`
 *      without touching the filesystem. Escape hatch for users who want to
 *      manage `pending/` themselves.
 *   2. If `<caveatHome>/pending/` does not yet exist, return
 *      `{ skipped: 'no_pending_dir' }` (nothing to sweep).
 *   3. Otherwise read `<caveatHome>/pending/.last-sweep` mtime. If the
 *      marker is fresher than `debounceDays` (default 1), skip with
 *      `{ skipped: 'debounced' }`.
 *   4. Otherwise call `cleanupStalePendingDirs(caveatHome, { staleDays })`
 *      and refresh the marker. Marker is refreshed even when the sweep
 *      removed nothing, so the next debounce window starts now.
 *
 * The marker file is `pending/.last-sweep`, which is intentionally placed
 * inside `pending/` itself: `cleanupStalePendingDirs` only descends into
 * directories under that root, so a top-level file is never collected.
 */
export function maybeSweepPendingDirs(
  caveatHome: string,
  options: { staleDays?: number; debounceDays?: number; now?: Date } = {},
): MaybeSweepResult {
  if (process.env.CAVEAT_PENDING_SWEEP === 'off') {
    return { skipped: 'env_off' };
  }
  const staleDays = options.staleDays ?? 7;
  const debounceDays = options.debounceDays ?? 1;
  if (debounceDays < 0) {
    throw new Error(
      `maybeSweepPendingDirs: debounceDays must be >= 0 (got ${debounceDays})`,
    );
  }
  const now = options.now ?? new Date();
  const pendingRoot = join(caveatHome, 'pending');
  if (!existsSync(pendingRoot)) return { skipped: 'no_pending_dir' };

  const marker = join(pendingRoot, '.last-sweep');
  try {
    const m = statSync(marker);
    const ageMs = now.getTime() - m.mtimeMs;
    if (ageMs < debounceDays * 24 * 60 * 60 * 1000) {
      return { skipped: 'debounced' };
    }
  } catch {
    // Marker missing: first sweep, fall through.
  }

  const result = cleanupStalePendingDirs(caveatHome, { staleDays, now });
  try {
    writeFileSync(marker, '', 'utf-8');
  } catch {
    // Best-effort: a missing marker just means the next call will sweep
    // again, which is wasteful but correct.
  }
  return { swept: result };
}

export interface PendingDrainResult { reminders: string[]; cleanupFailures: string[]; }

export interface PendingPeekResult {
  reminders: Array<{ path: string; text: string }>;
  readFailures: string[];
}

/** 削除せずに読み、hookのstdout書込み後だけ受領する。 */
export function peekPendingRemindersDetailed(caveatHome: string, sessionId: string): PendingPeekResult {
  const dir = pendingDirFor(caveatHome, sessionId);
  if (!existsSync(dir)) return { reminders: [], readFailures: [] };
  return withPendingQueueLock(caveatHome, () => {
    const reminders: PendingPeekResult['reminders'] = [];
    const readFailures: string[] = [];
    const entries = readdirSync(dir).filter((name) => name.endsWith('.txt') || name.endsWith('.ready'));
    entries.sort((left, right) => {
      const difference = statSync(join(dir, left)).mtimeMs - statSync(join(dir, right)).mtimeMs;
      return difference || left.localeCompare(right);
    });
    for (const name of entries) {
      const path = join(dir, name);
      try { reminders.push({ path, text: readFileSync(path, 'utf8') }); }
      catch { readFailures.push(name); }
    }
    return { reminders, readFailures };
  });
}

export function acknowledgePendingReminders(caveatHome: string, paths: string[]): void {
  if (paths.length === 0) return;
  const root = join(caveatHome, 'pending');
  withPendingQueueLock(caveatHome, () => {
    for (const path of paths) {
      if (!path.startsWith(`${root}/`) && !path.startsWith(`${root}\\`)) throw new Error('pending path outside root');
      try { unlinkSync(path); }
      catch (error: unknown) {
        if (!(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
      }
    }
  });
}

export function drainPendingRemindersDetailed(
  caveatHome: string,
  sessionId: string,
  fs: { read?: (path: string) => string; unlink?: (path: string) => void } = {},
): PendingDrainResult {
  const dir = pendingDirFor(caveatHome, sessionId);
  if (!existsSync(dir)) return { reminders: [], cleanupFailures: [] };
  try {
    return withPendingQueueLock(caveatHome, () => {
      let entries: string[];
      try {
        entries = readdirSync(dir).filter((f) => f.endsWith('.txt') || f.endsWith('.ready'));
      } catch {
        return { reminders: [], cleanupFailures: ['pending directory read failed'] };
      }
      const cleanupFailures: string[] = [];
      entries.sort((a, b) => {
        try { const diff = statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs; return diff || a.localeCompare(b); }
        catch { return a.localeCompare(b); }
      });
      const reminders: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry);
        try {
          reminders.push(fs.read ? fs.read(path) : readFileSync(path, 'utf-8'));
        } catch {
          cleanupFailures.push(entry);
          continue;
        }
        try {
          if (fs.unlink) fs.unlink(path); else unlinkSync(path);
        } catch {
          cleanupFailures.push(entry);
        }
      }
      return { reminders, cleanupFailures };
    });
  } catch {
    return { reminders: [], cleanupFailures: ['pending queue lock unavailable'] };
  }
}

export function drainPendingReminders(caveatHome: string, sessionId: string): string[] {
  return drainPendingRemindersDetailed(caveatHome, sessionId).reminders;
}

export function drainGlobalPendingReminders(caveatHome: string): string[] {
  return drainPendingReminders(caveatHome, GLOBAL_PENDING_SESSION);
}
