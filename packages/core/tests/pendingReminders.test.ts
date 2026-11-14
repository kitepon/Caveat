import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  appendPendingReminder,
  acquirePendingClaim,
  buildPendingSemanticKey,
  cleanupStalePendingDirs,
  drainPendingReminders,
  drainPendingRemindersDetailed,
  maybeSweepPendingDirs,
  pendingDirFor,
  publishPendingReminder,
  releasePendingClaim,
} from '../src/pendingReminders.js';

const OS_PROCESS_CONCURRENCY = 8;

function freshHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-pending-'));
  return {
    home,
    // Windows can retain a just-exited child process handle briefly. Node's
    // built-in bounded retry handles that transient EPERM without hiding a
    // persistent cleanup failure.
    cleanup: () => rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }),
  };
}

describe('pendingReminders', () => {
  it('uses sorted refs in an agent/surface semantic key', () => {
    const a = buildPendingSemanticKey({ agent: 'claude', surface: 'stop', refs: [{ source: 'own', id: 'b' }, { source: 'own', id: 'a' }], stopSignalDigest: 'x' });
    const b = buildPendingSemanticKey({ agent: 'claude', surface: 'stop', refs: [{ source: 'own', id: 'a' }, { source: 'own', id: 'b' }], stopSignalDigest: 'x' });
    expect(a).toBe(b);
    expect(a).not.toBe(buildPendingSemanticKey({ agent: 'codex', surface: 'stop', refs: [{ source: 'own', id: 'a' }, { source: 'own', id: 'b' }], stopSignalDigest: 'x' }));
    expect(a).toBe(buildPendingSemanticKey({ agent: 'claude', surface: 'stop', refs: [{ source: 'own', id: 'a' }, { source: 'own', id: 'a' }, { source: 'own', id: 'b' }], stopSignalDigest: 'x' }));
  });

  it('atomically coalesces concurrent same-key publishes and ignores torn files', async () => {
    const { home, cleanup } = freshHome();
    try {
      const key = buildPendingSemanticKey({ agent: 'claude', surface: 'tool_error', refs: [{ source: 'own', id: 'a' }] });
      const barrier = join(home, 'barrier');
      const fixture = fileURLToPath(new URL('./fixtures/pendingPublisher.mjs', import.meta.url));
      const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/pendingReminders.ts', import.meta.url))).href;
      const children = Array.from({ length: OS_PROCESS_CONCURRENCY }, () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fixture, moduleUrl, home, 's1', key, barrier], { stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill(); reject(new Error('publisher child timeout')); }, 15_000);
        child.once('error', reject);
        child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`publisher child exited ${code}`)); });
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(barrier, '', 'utf-8');
      await Promise.all(children);
      const dir = pendingDirFor(home, 's1');
      writeFileSync(join(dir, '.torn.tmp'), 'partial', 'utf-8');
      expect(drainPendingReminders(home, 's1')).toEqual(['only once']);
    } finally { cleanup(); }
  });

  it('runs a pre-publish builder exactly once across concurrent OS processes', async () => {
    const { home, cleanup } = freshHome();
    try {
      const key = buildPendingSemanticKey({ agent: 'claude', surface: 'stop', refs: [], stopSignalDigest: 'signal' });
      const barrier = join(home, 'builder-barrier'); const counter = join(home, 'builder-counter');
      const fixture = fileURLToPath(new URL('./fixtures/pendingBuilder.mjs', import.meta.url));
      const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/pendingReminders.ts', import.meta.url))).href;
      const children = Array.from({ length: OS_PROCESS_CONCURRENCY }, () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fixture, moduleUrl, home, 's1', key, barrier, counter], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        const timer = setTimeout(() => { child.kill(); reject(new Error('builder child timeout')); }, 15_000);
        child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`builder child exited ${code}: ${stderr.trim()}`)); });
      }));
      await new Promise((resolve) => setTimeout(resolve, 50)); writeFileSync(barrier, '', 'utf8'); await Promise.all(children);
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['1']);
      expect(drainPendingReminders(home, 's1')).toEqual(['built once']);
    } finally { cleanup(); }
  });

  it('reclaims one expired claim without an ABA double-builder across concurrent OS processes', async () => {
    const { home, cleanup } = freshHome();
    try {
      const key = buildPendingSemanticKey({ agent: 'claude', surface: 'stop', refs: [], stopSignalDigest: 'expired-signal' });
      expect(acquirePendingClaim(home, 's1', key, { now: Date.now() - 10 * 60 * 1_000 })).not.toBeNull();
      const barrier = join(home, 'expired-builder-barrier'); const counter = join(home, 'expired-builder-counter');
      const fixture = fileURLToPath(new URL('./fixtures/pendingBuilder.mjs', import.meta.url));
      const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/pendingReminders.ts', import.meta.url))).href;
      const children = Array.from({ length: OS_PROCESS_CONCURRENCY }, () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fixture, moduleUrl, home, 's1', key, barrier, counter], { stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill(); reject(new Error('expired builder child timeout')); }, 20_000);
        child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`expired builder child exited ${code}`)); });
      }));
      await new Promise((resolve) => setTimeout(resolve, 50)); writeFileSync(barrier, '', 'utf8'); await Promise.all(children);
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['1']);
      expect(drainPendingReminders(home, 's1')).toEqual(['built once']);
    } finally { cleanup(); }
  });

  it('does not let stale sweeping delete a concurrent fresh publish', async () => {
    const { home, cleanup } = freshHome();
    try {
      const publisher = fileURLToPath(new URL('./fixtures/pendingPublisher.mjs', import.meta.url));
      const sweeper = fileURLToPath(new URL('./fixtures/pendingSweeper.mjs', import.meta.url));
      const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/pendingReminders.ts', import.meta.url))).href;
      for (let index = 0; index < 12; index += 1) {
        const sessionId = `sweep-${index}`;
        const old = appendPendingReminder(home, sessionId, 'stale');
        const oldTime = (Date.now() - 30 * 24 * 60 * 60 * 1_000) / 1_000;
        utimesSync(old, oldTime, oldTime);
        utimesSync(pendingDirFor(home, sessionId), oldTime, oldTime);
        const key = buildPendingSemanticKey({ agent: 'claude', surface: 'tool_error', refs: [{ source: 'own', id: String(index) }] });
        const barrier = join(home, `sweep-barrier-${index}`);
        const children = [
          spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', publisher, moduleUrl, home, sessionId, key, barrier], { stdio: 'ignore' }),
          spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', sweeper, moduleUrl, home, barrier], { stdio: 'ignore' }),
        ];
        const exits = children.map((child) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error('sweep race child timeout')); }, 15_000);
          child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`sweep race child exited ${code}`)); });
        }));
        await new Promise((resolve) => setTimeout(resolve, 20)); writeFileSync(barrier, '', 'utf8'); await Promise.all(exits);
        const reminders = drainPendingReminders(home, sessionId);
        expect(reminders.filter((text) => text === 'only once')).toHaveLength(1);
      }
    } finally { cleanup(); }
  });

  it('keeps a live builder claim when staleDays is zero', async () => {
    const { home, cleanup } = freshHome();
    try {
      const key = buildPendingSemanticKey({ agent: 'claude', surface: 'stop', refs: [], stopSignalDigest: 'live-zero' });
      const started = join(home, 'blocking-builder-started');
      const release = join(home, 'blocking-builder-release');
      const fixture = fileURLToPath(new URL('./fixtures/pendingBlockingBuilder.mjs', import.meta.url));
      const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/pendingReminders.ts', import.meta.url))).href;
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', fixture, moduleUrl, home, 's1', key, started, release], { stdio: 'ignore' });
      const exit = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('blocking builder child timeout')); }, 15_000);
        child.once('error', reject); child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`blocking builder child exited ${code}`)); });
      });
      const deadline = Date.now() + 5_000;
      while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(existsSync(started)).toBe(true);
      const swept = cleanupStalePendingDirs(home, { staleDays: 0, now: new Date(Date.now() + 1) });
      expect(swept.removed).toEqual([]);
      expect(swept.kept).toBe(1);
      writeFileSync(release, '', 'utf8');
      await exit;
      expect(drainPendingReminders(home, 's1')).toEqual(['built after sweep']);
    } finally { cleanup(); }
  });

  it('reclaims expired claims and reports cleanup failures through the detailed API', () => {
    const { home, cleanup } = freshHome();
    try {
      const key = buildPendingSemanticKey({ agent: 'claude', surface: 'tool_error', refs: [] });
      const first = acquirePendingClaim(home, 's1', key, { now: 1000, ttlMs: 10 });
      expect(first).not.toBeNull();
      expect(acquirePendingClaim(home, 's1', key, { now: 1005, ttlMs: 10 })).toBeNull();
      const second = acquirePendingClaim(home, 's1', key, { now: 2000, ttlMs: 10 });
      expect(second).not.toBeNull();
      releasePendingClaim(second!);
      expect(drainPendingRemindersDetailed(home, 's1')).toEqual({ reminders: [], cleanupFailures: [] });
    } finally { cleanup(); }
  });

  it('does not suppress a different semantic key in the same session', () => {
    const { home, cleanup } = freshHome();
    try {
      const firstKey = buildPendingSemanticKey({ agent: 'claude', surface: 'tool_error', refs: [{ source: 'own', id: 'a' }] });
      const secondKey = buildPendingSemanticKey({ agent: 'claude', surface: 'tool_error', refs: [{ source: 'own', id: 'b' }] });
      const first = acquirePendingClaim(home, 's1', firstKey);
      const second = acquirePendingClaim(home, 's1', secondKey);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      releasePendingClaim(first!);
      releasePendingClaim(second!);
    } finally { cleanup(); }
  });

  it('does not claim a semantic request after its ready payload exists', () => {
    const { home, cleanup } = freshHome();
    try {
      const key = buildPendingSemanticKey({ agent: 'claude', surface: 'tool_error', refs: [] });
      publishPendingReminder(home, 's1', key, 'done');
      expect(acquirePendingClaim(home, 's1', key)).toBeNull();
    } finally { cleanup(); }
  });

  it('exposes read and unlink failures while retaining content for retry', () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 's1', 'visible');
      const readFailure = drainPendingRemindersDetailed(home, 's1', { read: () => { throw new Error('read fail'); } });
      expect(readFailure).toEqual({ reminders: [], cleanupFailures: expect.any(Array) });
      expect(readFailure.cleanupFailures).toHaveLength(1);
      const unlinkFailure = drainPendingRemindersDetailed(home, 's1', { unlink: () => { throw new Error('unlink fail'); } });
      expect(unlinkFailure).toEqual({ reminders: ['visible'], cleanupFailures: expect.any(Array) });
      expect(unlinkFailure.cleanupFailures).toHaveLength(1);
      expect(drainPendingReminders(home, 's1')).toEqual(['visible']);
      expect(drainPendingReminders(home, 's1')).toEqual([]);
    } finally { cleanup(); }
  });

  it('fails a contended drain quickly and retains the reminder for retry', () => {
    const { home, cleanup } = freshHome();
    let lockDb: DatabaseSync | undefined;
    try {
      appendPendingReminder(home, 's1', 'retry after busy');
      lockDb = new DatabaseSync(join(home, 'pending', '.queue-lock.sqlite'));
      lockDb.exec('BEGIN IMMEDIATE');
      const startedAt = Date.now();
      const blocked = drainPendingRemindersDetailed(home, 's1');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(blocked).toEqual({ reminders: [], cleanupFailures: ['pending queue lock unavailable'] });
      lockDb.exec('ROLLBACK');
      lockDb.close();
      lockDb = undefined;
      expect(drainPendingReminders(home, 's1')).toEqual(['retry after busy']);
    } finally {
      try { lockDb?.exec('ROLLBACK'); } catch { /* already released */ }
      try { lockDb?.close(); } catch { /* already closed */ }
      cleanup();
    }
  });

  it('drains nothing when no pending dir exists', () => {
    const { home, cleanup } = freshHome();
    try {
      expect(drainPendingReminders(home, 's1')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('append then drain returns the reminder once; second drain is empty', () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 's1', 'hello-world');
      expect(drainPendingReminders(home, 's1')).toEqual(['hello-world']);
      expect(drainPendingReminders(home, 's1')).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('preserves timestamp-ordered delivery of multiple reminders', async () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 's1', 'first');
      // tiny delay so the filename ordering is deterministic
      await new Promise((r) => setTimeout(r, 5));
      appendPendingReminder(home, 's1', 'second');
      const drained = drainPendingReminders(home, 's1');
      expect(drained).toEqual(['first', 'second']);
    } finally {
      cleanup();
    }
  });

  it('orders ready and legacy txt reminders together by mtime', () => {
    const { home, cleanup } = freshHome();
    try {
      const key = buildPendingSemanticKey({ agent: 'claude', surface: 'tool_error', refs: [{ source: 'own', id: 'ready' }] });
      const ready = publishPendingReminder(home, 's1', key, 'ready-first').path;
      const legacy = appendPendingReminder(home, 's1', 'legacy-second');
      utimesSync(ready, 1_000, 1_000);
      utimesSync(legacy, 2_000, 2_000);
      expect(drainPendingReminders(home, 's1')).toEqual(['ready-first', 'legacy-second']);
    } finally {
      cleanup();
    }
  });

  it('isolates reminders between sessions', () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 'sess-a', 'for-a');
      appendPendingReminder(home, 'sess-b', 'for-b');
      expect(drainPendingReminders(home, 'sess-a')).toEqual(['for-a']);
      expect(drainPendingReminders(home, 'sess-b')).toEqual(['for-b']);
    } finally {
      cleanup();
    }
  });

  it('sanitizes session id so traversal characters cannot escape pending dir', () => {
    const { home, cleanup } = freshHome();
    try {
      const dirty = '../../etc/passwd';
      appendPendingReminder(home, dirty, 'x');
      const expectedDir = pendingDirFor(home, dirty);
      // Should live under a sanitized leaf under pending/, not in parent dirs
      expect(expectedDir.startsWith(join(home, 'pending'))).toBe(true);
      const files = readdirSync(expectedDir);
      expect(files.length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('drain removes files after reading', () => {
    const { home, cleanup } = freshHome();
    try {
      appendPendingReminder(home, 's1', 'a');
      appendPendingReminder(home, 's1', 'b');
      drainPendingReminders(home, 's1');
      const dir = pendingDirFor(home, 's1');
      expect(readdirSync(dir).filter((f) => f.endsWith('.txt'))).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe('cleanupStalePendingDirs', () => {
  function ageDir(path: string, daysAgo: number): void {
    const t = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, t, t);
  }

  it('returns no-op when pending root does not exist', () => {
    const { home, cleanup } = freshHome();
    try {
      const result = cleanupStalePendingDirs(home);
      expect(result).toEqual({ removed: [], kept: 0 });
    } finally {
      cleanup();
    }
  });

  it('removes empty session dirs that are older than the threshold', () => {
    const { home, cleanup } = freshHome();
    try {
      const oldDir = pendingDirFor(home, 'old-empty');
      const recentDir = pendingDirFor(home, 'recent-empty');
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(recentDir, { recursive: true });
      ageDir(oldDir, 30);
      // recentDir keeps "now" mtime
      const result = cleanupStalePendingDirs(home, { staleDays: 7 });
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]).toBe(oldDir);
      expect(result.kept).toBe(1);
      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(recentDir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('removes session dirs with stranded files when ALL contents are stale', () => {
    const { home, cleanup } = freshHome();
    try {
      const stranded = pendingDirFor(home, 'stranded');
      mkdirSync(stranded, { recursive: true });
      const file = join(stranded, '1700000000-aaaa.txt');
      writeFileSync(file, 'leftover', 'utf-8');
      ageDir(file, 30);
      ageDir(stranded, 30);
      const result = cleanupStalePendingDirs(home, { staleDays: 7 });
      expect(result.removed).toEqual([stranded]);
      expect(existsSync(stranded)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('keeps a session dir whose newest file is fresher than the threshold', () => {
    const { home, cleanup } = freshHome();
    try {
      const dir = pendingDirFor(home, 'half-active');
      mkdirSync(dir, { recursive: true });
      const oldFile = join(dir, 'old.txt');
      const freshFile = join(dir, 'fresh.txt');
      writeFileSync(oldFile, 'x', 'utf-8');
      writeFileSync(freshFile, 'y', 'utf-8');
      ageDir(oldFile, 30);
      ageDir(dir, 30);
      // freshFile keeps "now" mtime
      const result = cleanupStalePendingDirs(home, { staleDays: 7 });
      expect(result.removed).toEqual([]);
      expect(result.kept).toBe(1);
      expect(existsSync(dir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('rejects negative staleDays', () => {
    const { home, cleanup } = freshHome();
    try {
      expect(() => cleanupStalePendingDirs(home, { staleDays: -1 })).toThrow();
    } finally {
      cleanup();
    }
  });

  it('staleDays=0 collects every dir whose mtime is strictly in the past', async () => {
    const { home, cleanup } = freshHome();
    try {
      const dir = pendingDirFor(home, 'just-now');
      mkdirSync(dir, { recursive: true });
      // age by 1 second so mtime is strictly < now
      ageDir(dir, 1 / 86400);
      const result = cleanupStalePendingDirs(home, { staleDays: 0 });
      expect(result.removed).toEqual([dir]);
    } finally {
      cleanup();
    }
  });
});

describe('maybeSweepPendingDirs', () => {
  function ageDir(path: string, daysAgo: number): void {
    const t = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, t, t);
  }

  function withoutSweepEnv<T>(fn: () => T): T {
    const prev = process.env.CAVEAT_PENDING_SWEEP;
    delete process.env.CAVEAT_PENDING_SWEEP;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CAVEAT_PENDING_SWEEP;
      else process.env.CAVEAT_PENDING_SWEEP = prev;
    }
  }

  it('returns env_off without filesystem effects when CAVEAT_PENDING_SWEEP=off', () => {
    const { home, cleanup } = freshHome();
    const prev = process.env.CAVEAT_PENDING_SWEEP;
    process.env.CAVEAT_PENDING_SWEEP = 'off';
    try {
      const stale = pendingDirFor(home, 'should-survive');
      mkdirSync(stale, { recursive: true });
      ageDir(stale, 30);
      const result = maybeSweepPendingDirs(home);
      expect(result).toEqual({ skipped: 'env_off' });
      expect(existsSync(stale)).toBe(true);
      // Marker must NOT have been written either (would let a later
      // env=on call skip via debounce, which is wrong).
      expect(existsSync(join(home, 'pending', '.last-sweep'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CAVEAT_PENDING_SWEEP;
      else process.env.CAVEAT_PENDING_SWEEP = prev;
      cleanup();
    }
  });

  it('returns no_pending_dir when the pending root does not exist', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        expect(maybeSweepPendingDirs(home)).toEqual({ skipped: 'no_pending_dir' });
      });
    } finally {
      cleanup();
    }
  });

  it('first call sweeps and creates the marker', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        const stale = pendingDirFor(home, 'old');
        mkdirSync(stale, { recursive: true });
        ageDir(stale, 30);
        const result = maybeSweepPendingDirs(home, { staleDays: 7 });
        expect(result.swept?.removed).toHaveLength(1);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(join(home, 'pending', '.last-sweep'))).toBe(true);
      });
    } finally {
      cleanup();
    }
  });

  it('subsequent call within debounce window is skipped', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        // Put a fresh marker in place.
        mkdirSync(join(home, 'pending'), { recursive: true });
        writeFileSync(join(home, 'pending', '.last-sweep'), '', 'utf-8');
        // And a stale dir that WOULD be removed if we swept.
        const stale = pendingDirFor(home, 'old');
        mkdirSync(stale, { recursive: true });
        ageDir(stale, 30);
        const result = maybeSweepPendingDirs(home, { debounceDays: 1 });
        expect(result).toEqual({ skipped: 'debounced' });
        expect(existsSync(stale)).toBe(true);
      });
    } finally {
      cleanup();
    }
  });

  it('subsequent call after debounce window sweeps again', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        const markerDir = join(home, 'pending');
        mkdirSync(markerDir, { recursive: true });
        const marker = join(markerDir, '.last-sweep');
        writeFileSync(marker, '', 'utf-8');
        // Age the marker beyond the debounce window.
        const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
        utimesSync(marker, tenDaysAgo, tenDaysAgo);
        // Stale dir that should be collected.
        const stale = pendingDirFor(home, 'old');
        mkdirSync(stale, { recursive: true });
        ageDir(stale, 30);
        const result = maybeSweepPendingDirs(home, { debounceDays: 1, staleDays: 7 });
        expect(result.swept?.removed).toEqual([stale]);
      });
    } finally {
      cleanup();
    }
  });

  it('rejects negative debounceDays', () => {
    const { home, cleanup } = freshHome();
    try {
      withoutSweepEnv(() => {
        mkdirSync(join(home, 'pending'), { recursive: true });
        expect(() => maybeSweepPendingDirs(home, { debounceDays: -1 })).toThrow();
      });
    } finally {
      cleanup();
    }
  });
});
