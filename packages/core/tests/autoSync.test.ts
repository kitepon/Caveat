import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireFileLock,
  AUTO_SYNC_DEBOUNCE_MS,
  AUTO_SYNC_RECORD_DEBOUNCE_MS,
  autoSyncNotification,
  autoSyncStatePath,
  CAVEAT_AUTO_SYNC_DEBOUNCE_ENV,
  CAVEAT_AUTO_SYNC_ENV,
  classifyOwnSyncOutcome,
  ownSyncFailureSignature,
  PROBE_REQUEST_FAILED_REASON,
  readAutoSyncState,
  releaseFileLock,
  resetAutoSyncFailureState,
  SyncError,
  triggerAutoSync,
  writeAutoSyncState,
  type SyncErrorCode,
} from '../src/index.js';

function fresh(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-auto-sync-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// triggerAutoSync validates its CLI script path only *after* the debounce gate
// lets it through, so an empty script path turns "would spawn" into a throw.
// That keeps these assertions honest without launching background workers.
function wouldSpawn(home: string): boolean {
  try {
    triggerAutoSync({ caveatHome: home, cliScript: '' });
    return false;
  } catch {
    return true;
  }
}

function markCycleFinished(home: string, agoMs = 0): void {
  writeAutoSyncState(home, {
    finishedAt: new Date(Date.now() - agoMs).toISOString(),
    signature: 'sig',
    ownSync: { consecutiveFailureSignature: null, consecutiveFailureCount: 0 },
  });
  // The gate reads mtime, not the payload. Ageing it explicitly keeps these
  // assertions off the boundary, where filesystem sub-millisecond timestamps
  // can land marginally ahead of Date.now().
  const seconds = (Date.now() - agoMs) / 1000;
  utimesSync(autoSyncStatePath(home), seconds, seconds);
}

describe('auto sync trigger', () => {
  afterEach(() => {
    delete process.env[CAVEAT_AUTO_SYNC_ENV];
    delete process.env[CAVEAT_AUTO_SYNC_DEBOUNCE_ENV];
  });

  it('does not discard an MCP write just after a completed cycle', () => {
    const { home, cleanup } = fresh();
    try {
      markCycleFinished(home, 900);
      expect(wouldSpawn(home)).toBe(false);
      expect(() => triggerAutoSync({
        caveatHome: home, cliScript: '', debounceMs: AUTO_SYNC_RECORD_DEBOUNCE_MS,
      })).toThrow('current Caveat CLI script path is unavailable');
      process.env[CAVEAT_AUTO_SYNC_ENV] = 'off';
      expect(() => triggerAutoSync({
        caveatHome: home, cliScript: '', debounceMs: AUTO_SYNC_RECORD_DEBOUNCE_MS,
      })).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('spawns when no cycle has run, and debounces against a recent one', () => {
    const { home, cleanup } = fresh();
    try {
      expect(wouldSpawn(home)).toBe(true);
      markCycleFinished(home, 60_000);
      expect(wouldSpawn(home)).toBe(false);
      // A cycle older than the default interval no longer gates.
      markCycleFinished(home, AUTO_SYNC_DEBOUNCE_MS + 60_000);
      expect(wouldSpawn(home)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('honors the kill switch', () => {
    const { home, cleanup } = fresh();
    try {
      process.env[CAVEAT_AUTO_SYNC_ENV] = 'off';
      expect(wouldSpawn(home)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('falls back to the default when the debounce override is malformed', () => {
    const { home, cleanup } = fresh();
    try {
      markCycleFinished(home, 2 * 60_000);
      // `Number('abc')` is NaN and `elapsed < NaN` is false, so garbage here
      // used to mean "spawn a worker on every single trigger".
      process.env[CAVEAT_AUTO_SYNC_DEBOUNCE_ENV] = 'abc';
      expect(wouldSpawn(home)).toBe(false);
      process.env[CAVEAT_AUTO_SYNC_DEBOUNCE_ENV] = '-1';
      expect(wouldSpawn(home)).toBe(false);
      // A valid override still wins over the default.
      process.env[CAVEAT_AUTO_SYNC_DEBOUNCE_ENV] = '1000';
      expect(wouldSpawn(home)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('auto sync core', () => {
  it('classifies own sync outcomes by sync code and probe reason', () => {
    const skipCodes: SyncErrorCode[] = [
      'NOT_A_REPO',
      'NO_REMOTE',
      'EXTERNAL_TOPLEVEL',
      'DETACHED_HEAD',
      'OWN_REPO_EXISTS',
      'BOTH_HAVE_ENTRIES',
    ];
    for (const code of skipCodes) {
      expect(classifyOwnSyncOutcome(new SyncError(code, code), undefined)).toBe('skip');
    }

    expect(classifyOwnSyncOutcome(new SyncError('REMOTE_PUBLIC', 'public'), undefined)).toBe('fail');
    expect(classifyOwnSyncOutcome(new SyncError('SYNC_CONFLICT', 'conflict'), undefined)).toBe('fail');
    expect(classifyOwnSyncOutcome(
      new SyncError('REMOTE_VISIBILITY_INDETERMINATE', 'network'),
      { kind: 'indeterminate', reason: PROBE_REQUEST_FAILED_REASON },
    )).toBe('network-skip');
    expect(classifyOwnSyncOutcome(
      new SyncError('REMOTE_VISIBILITY_INDETERMINATE', '403'),
      { kind: 'indeterminate', reason: 'unexpected HTTP status 403' },
    )).toBe('fail');
    expect(classifyOwnSyncOutcome(new Error('boom'), undefined)).toBe('fail');
  });

  it('derives failure signatures from code only, ignoring volatile git output', () => {
    // Same code, different (git-derived) message detail → same signature, so a
    // persistent SYNC_CONFLICT whose git output changes every rebase still
    // accumulates toward the E-5 suspend threshold.
    const a = ownSyncFailureSignature(new SyncError('SYNC_CONFLICT', 'CONFLICT in a.md\nabc123'));
    const b = ownSyncFailureSignature(new SyncError('SYNC_CONFLICT', 'CONFLICT in b.md\ndef456'));
    const c = ownSyncFailureSignature(new SyncError('REMOTE_PUBLIC', 'CONFLICT in a.md\nabc123'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('reports only notification-worthy autosync outcomes and dedupes by signature', () => {
    const quiet = autoSyncNotification({
      community: [{ handle: 'alice', status: 'ok' }],
      own: { disposition: 'success', pulled: false, changedFiles: 0 },
    });
    expect(quiet.text).toBeNull();
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'skip', code: 'NOT_A_REPO' },
    }).text).toBeNull();
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'network-skip', code: 'REMOTE_VISIBILITY_INDETERMINATE' },
    }).text).toBeNull();

    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'success', pulled: true, changedFiles: 1 },
    }).text).toContain('private remote');
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'fail', code: 'REMOTE_PUBLIC' },
    }).text).toContain('REMOTE_PUBLIC');
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'fail', code: 'SYNC_CONFLICT', escalated: true, degraded: true },
    }).text).toContain('backed off');
    // Retrying-and-failing and sitting inside the backoff are the same story to
    // the reader, so they must produce one message and one signature.
    const degradedFail = autoSyncNotification({
      community: [],
      own: { disposition: 'fail', code: 'SYNC_CONFLICT', degraded: true },
    });
    const degradedSkip = autoSyncNotification({
      community: [],
      own: { disposition: 'skip', suspended: true, degraded: true },
    });
    expect(degradedSkip.text).toBe(degradedFail.text);
    expect(degradedSkip.signature).toBe(degradedFail.signature);
    expect(autoSyncNotification({
      community: [{ handle: 'team', status: 'failed', message: 'nope' }],
      own: { disposition: 'skip' },
    }).text).toContain('team');
    expect(autoSyncNotification({
      community: [],
      own: { disposition: 'success', pulled: false, changedFiles: 0 },
    }).signature).toBe(quiet.signature);
  });

  it('round-trips state, rejects malformed state, and resets failure counters', () => {
    const { home, cleanup } = fresh();
    try {
      expect(readAutoSyncState(home)).toBeNull();
      writeAutoSyncState(home, {
        finishedAt: '2026-07-12T00:00:00.000Z',
        signature: 'sig',
        ownSync: { consecutiveFailureSignature: 'fail', consecutiveFailureCount: 2 },
      });
      expect(readAutoSyncState(home)).toEqual({
        finishedAt: '2026-07-12T00:00:00.000Z',
        signature: 'sig',
        ownSync: { consecutiveFailureSignature: 'fail', consecutiveFailureCount: 2 },
      });
      resetAutoSyncFailureState(home);
      expect(readAutoSyncState(home)?.ownSync).toEqual({
        consecutiveFailureSignature: null,
        consecutiveFailureCount: 0,
      });
      writeFileSync(autoSyncStatePath(home), '{"finishedAt":"x"}', 'utf-8');
      expect(readAutoSyncState(home)).toBeNull();
      writeFileSync(autoSyncStatePath(home), '{bad', 'utf-8');
      expect(readAutoSyncState(home)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('acquires generic file locks exclusively and replaces stale locks', () => {
    const { home, cleanup } = fresh();
    try {
      const path = join(home, 'sync', '.generic-lock');
      const lock = acquireFileLock(path);
      expect(lock).not.toBeNull();
      expect(acquireFileLock(path)).toBeNull();
      releaseFileLock(lock!);
      expect(existsSync(path)).toBe(false);

      mkdirSync(join(home, 'sync'), { recursive: true });
      writeFileSync(path, '99999999', 'utf-8');
      const replacement = acquireFileLock(path);
      expect(replacement).not.toBeNull();
      expect(readFileSync(path, 'utf-8')).toBe(String(process.pid));
      releaseFileLock(replacement!);
    } finally {
      cleanup();
    }
  });
});
