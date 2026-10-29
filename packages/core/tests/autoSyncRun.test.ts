import { isolatedGitEnv } from '../../../scripts/test-git-env.mjs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_SYNC_DEGRADED_RETRY_MS,
  AUTO_SYNC_NOTICE_REPEAT_MS,
  drainGlobalPendingReminders,
  readAutoSyncState,
  resetAutoSyncFailureState,
  runAutoSync,
  type Logger,
} from '../src/index.js';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env, ...isolatedGitEnv(process.env.HOME!),
      GIT_AUTHOR_NAME: 'Caveat Test',
      GIT_AUTHOR_EMAIL: 'caveat@example.com',
      GIT_COMMITTER_NAME: 'Caveat Test',
      GIT_COMMITTER_EMAIL: 'caveat@example.com',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function entry(): string {
  return `---
id: pulsar-drift
title: Pulsar drift calibration failure
visibility: private
confidence: confirmed
tags: [pulsar, drift]
environment: {}
source_project: null
source_session: test
created_at: 2026-07-12
updated_at: 2026-07-12
---

## Symptom
Pulsar drift calibration failure reports a rare anchor mismatch.
`;
}

/**
 * Own repo whose only remote is an un-probeable file:// URL. syncOwn's
 * preflight cannot verify the remote is private (deriveAnonymousProbeUrl
 * returns undefined for file://), so with trustRemotePrivate:false it throws
 * REMOTE_VISIBILITY_INDETERMINATE *before any push* — a deterministic,
 * side-effect-free own-sync 'fail' we can repeat to exercise the E-5 escape.
 */
function freshOwnRepoWithUnprobeableRemote(): { home: string; paths: { dbPath: string; entriesDir: string; communityDir: string }; ownDir: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-autosync-run-'));
  for (const [key, value] of Object.entries(isolatedGitEnv(join(home, 'git-home')))) vi.stubEnv(key, /^GIT_CONFIG/i.test(key) ? undefined : value);
  const ownDir = join(home, 'own');
  const entriesDir = join(ownDir, 'entries');
  mkdirSync(entriesDir, { recursive: true });
  mkdirSync(join(home, 'community'), { recursive: true });
  mkdirSync(join(home, 'index'), { recursive: true });
  const bare = join(home, 'remote.git');
  git(['init', '--bare', bare], home);
  git(['init', '-b', 'main', ownDir], home);
  git(['remote', 'add', 'origin', `file://${bare}`], ownDir);
  writeFileSync(join(entriesDir, 'pulsar.md'), entry());
  git(['add', '-A'], ownDir);
  git(['commit', '-m', 'own entry'], ownDir);
  return {
    home,
    ownDir,
    paths: {
      dbPath: join(home, 'index', 'caveat.db'),
      entriesDir,
      communityDir: join(home, 'community'),
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('runAutoSync own-sync failure escape (E-5)', () => {
  it('applies its background git timeout policy to own sync', async () => {
    const { home, paths, ownDir, cleanup } = freshOwnRepoWithUnprobeableRemote();
    try {
      const result = await runAutoSync({
        caveatHome: home,
        ownDir,
        paths,
        logger: silent,
        gitTimeoutMs: 5_999,
      });
      expect(result.outcome?.own).toMatchObject({
        disposition: 'fail',
        code: undefined,
      });
    } finally {
      cleanup();
    }
  });

  // Seven autosync cycles with real Git measured 4.205s on non-admin Windows and exceeded
  // the default 5s in the PR matrix (that timeout is a lower bound).
  // Give this state-transition sequence 10s without changing its assertions.
  it('increments on repeated failure, escalates once at 3, suspends after, and resets manually', { timeout: 10_000 }, async () => {
    const { home, paths, ownDir, cleanup } = freshOwnRepoWithUnprobeableRemote();
    try {
      const opts = { caveatHome: home, ownDir, paths, logger: silent };

      // Cycle 1: first failure → count 1, notified.
      const r1 = await runAutoSync(opts);
      expect(r1.ran).toBe(true);
      expect(r1.outcome?.own.disposition).toBe('fail');
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(1);
      expect(r1.notified).toBe(true);
      const drained1 = drainGlobalPendingReminders(home);
      expect(drained1.join('\n')).toContain('own sync failed');

      // Cycle 2: same failure → count 2, deduped (no new notification).
      const r2 = await runAutoSync(opts);
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(2);
      expect(r2.notified).toBe(false);
      expect(drainGlobalPendingReminders(home)).toHaveLength(0);

      // Cycle 3: third failure → count 3, escalated once.
      const r3 = await runAutoSync(opts);
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(3);
      expect(r3.outcome?.own.escalated).toBe(true);
      expect(r3.notified).toBe(true);
      expect(drainGlobalPendingReminders(home).join('\n')).toContain('auto-retry is backed off');

      // Cycle 4: inside the backoff — own sync not attempted, count frozen, and
      // deduped against cycle 3's identical degraded message.
      const r4 = await runAutoSync(opts);
      expect(r4.outcome?.own.suspended).toBe(true);
      expect(r4.outcome?.own.disposition).toBe('skip');
      expect(r4.outcome?.own.degraded).toBe(true);
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(3);
      expect(r4.notified).toBe(false);
      expect(drainGlobalPendingReminders(home)).toHaveLength(0);

      // Once the backoff elapses auto-retry resumes on its own: a broken remote
      // that recovers must not stay dead until someone runs a manual sync.
      const afterBackoff = new Date(Date.now() + AUTO_SYNC_DEGRADED_RETRY_MS + 60_000);
      const r5 = await runAutoSync({ ...opts, now: () => afterBackoff });
      expect(r5.outcome?.own.disposition).toBe('fail');
      expect(r5.outcome?.own.suspended).toBeUndefined();
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(4);
      // Same degraded message as before, and still inside the notice window.
      expect(r5.notified).toBe(false);
      expect(drainGlobalPendingReminders(home)).toHaveLength(0);

      // A degraded sync re-announces itself once the notice window passes, so
      // it can never rot silently.
      const afterNotice = new Date(Date.now() + AUTO_SYNC_NOTICE_REPEAT_MS + 60_000);
      const r6 = await runAutoSync({ ...opts, now: () => afterNotice });
      expect(r6.outcome?.own.degraded).toBe(true);
      expect(r6.notified).toBe(true);
      expect(drainGlobalPendingReminders(home).join('\n')).toContain('keeps failing');

      // Manual sync success resets the counter and clears the backoff.
      resetAutoSyncFailureState(home);
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(0);
      const r7 = await runAutoSync(opts);
      expect(r7.outcome?.own.disposition).toBe('fail');
      expect(r7.outcome?.own.degraded).toBeUndefined();
      expect(readAutoSyncState(home)?.ownSync.consecutiveFailureCount).toBe(1);
    } finally {
      cleanup();
    }
  });
});

afterEach(() => { vi.unstubAllEnvs(); });
