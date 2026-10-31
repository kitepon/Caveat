import { isolatedGitEnv } from '../../../scripts/test-git-env.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { readPeriodicSyncState, runPeriodicSync } from '../src/periodicSync.js';
import { syncOwn, SyncError } from '../src/sync.js';
import { acquireFileLock, releaseFileLock } from '../src/autoReindex.js';
import { AUTO_SYNC_WRITE_LOCK_WAIT_MS, runAutoSync, writeAutoSyncState } from '../src/autoSync.js';
import { updateEntry } from '../src/update.js';

vi.mock('../src/sync.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sync.js')>();
  return { ...actual, syncOwn: vi.fn(actual.syncOwn) };
});

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const denied = async () => ({ kind: 'denied' as const, status: 404 });
const roots: string[] = [];
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Caveat Test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'fixture@example.invalid';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { env: { ...process.env, ...isolatedGitEnv(process.env.HOME!) }, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const entry = (text: string) => `---\nid: periodic-entry\ntitle: Periodic reception fixture\nvisibility: private\nconfidence: confirmed\ntags: [periodic]\nenvironment: {}\ncreated_at: 2026-10-15\nupdated_at: 2026-10-15\n---\n\n## Symptom\n${text}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caveat-periodic-')); roots.push(root);
  for (const [key, value] of Object.entries(isolatedGitEnv(join(root, 'git-home')))) vi.stubEnv(key, /^GIT_CONFIG/i.test(key) ? undefined : value);
  const bare = join(root, 'remote.git'); const ownDir = join(root, 'own'); const peer = join(root, 'peer');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(root, 'init', '-b', 'main', ownDir);
  git(ownDir, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(ownDir, 'entries'));
  const file = join(ownDir, 'entries', 'fixture.md'); writeFileSync(file, entry('base'));
  git(ownDir, 'add', '-A'); git(ownDir, 'commit', '-m', 'base');
  git(ownDir, 'remote', 'add', 'origin', bare); git(ownDir, 'push', '-u', 'origin', 'main');
  git(root, 'clone', bare, peer); git(peer, 'config', 'commit.gpgsign', 'false');
  const caveatHome = join(root, 'home');
  const paths = { dbPath: join(caveatHome, 'index', 'caveat.db'), entriesDir: join(ownDir, 'entries'), communityDir: join(caveatHome, 'community') };
  const opts = { caveatHome, ownDir, paths, logger: silent, probeImpl: denied, intervalMs: 0 };
  const updatePeer = (text: string) => {
    writeFileSync(join(peer, 'entries', 'fixture.md'), entry(text));
    git(peer, 'add', '-A'); git(peer, 'commit', '-m', 'peer update'); git(peer, 'push', 'origin', 'main');
  };
  return { root, bare, ownDir, peer, file, opts, updatePeer };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe('periodic reception with isolated Git and SQLite', { timeout: 60_000 }, () => {
  it('receives another terminal update without a conversation and indexes the same content', async () => {
    const f = fixture(); f.updatePeer('new peer knowledge');
    const result = await runPeriodicSync(f.opts);
    expect(result).toMatchObject({ status: 'success', reason: 'synced_and_indexed' });
    expect(git(f.ownDir, 'rev-parse', 'HEAD')).toBe(git(f.peer, 'rev-parse', 'HEAD'));
    const db = openDb({ path: f.opts.paths.dbPath, logger: silent });
    try { expect(db.prepare('SELECT body FROM entries WHERE source=? AND id=?').get('own', 'periodic-entry')).toMatchObject({ body: expect.stringContaining('new peer knowledge') }); }
    finally { db.close(); }
    expect(readPeriodicSyncState(f.opts.caveatHome)?.last_success_at).toBe(result.finished_at);
  });

  it.each(['unstaged', 'staged', 'untracked'] as const)('preserves %s editing and performs no own remote probe', async kind => {
    const f = fixture(); const head = git(f.ownDir, 'rev-parse', 'HEAD');
    const file = kind === 'untracked' ? join(f.ownDir, 'draft.md') : f.file;
    writeFileSync(file, 'unfinished local input');
    if (kind === 'staged') git(f.ownDir, 'add', file);
    const status = git(f.ownDir, 'status', '--porcelain'); let probes = 0;
    const result = await runPeriodicSync({ ...f.opts, probeImpl: async () => { probes++; return denied(); } });
    expect(result).toMatchObject({ status: 'skipped', reason: 'worktree_dirty' });
    expect(probes).toBe(0); expect(readFileSync(file, 'utf8')).toBe('unfinished local input');
    expect(git(f.ownDir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(f.ownDir, 'status', '--porcelain')).toBe(status);
    expect(existsSync(f.opts.paths.dbPath)).toBe(false);
  });

  it('serializes two homes sharing one repository and releases locks for retry', async () => {
    const f = fixture(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inProbe = new Promise<void>(resolve => { entered = resolve; });
    const first = syncOwn({ ...f.opts, probeImpl: async () => { entered(); await gate; return denied(); } });
    await inProbe;
    const otherHome = join(f.root, 'other-home');
    try {
      await expect(syncOwn({ ...f.opts, caveatHome: otherHome, paths: { ...f.opts.paths, dbPath: join(otherHome, 'index', 'caveat.db') } }))
        .rejects.toMatchObject({ code: 'SYNC_BUSY' });
    } finally { release(); await first; }
    expect((await runPeriodicSync(f.opts)).status).toBe('success');
  });

  it('syncs an update made during a cycle and coalesces waiting write workers', async () => {
    const f = fixture(); const actual = await vi.importActual<typeof import('../src/sync.js')>('../src/sync.js');
    let release!: () => void; let entered!: () => void; let clock = 1_000; let probes = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pushed = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(syncOwn).mockImplementationOnce(async opts => {
      const result = await actual.syncOwn(opts); entered(); await gate; return result;
    });
    const opts = { ...f.opts, now: () => new Date(clock), probeImpl: async () => { probes++; return denied(); } };
    const first = runAutoSync(opts); const pending: Array<ReturnType<typeof runAutoSync>> = [];
    try {
      await pushed;
      const db = openDb({ path: f.opts.paths.dbPath, logger: silent });
      try { updateEntry('periodic-entry', { sections: { Symptom: 'updated while the first cycle holds its locks' } }, { db, entriesRoot: f.opts.paths.entriesDir }); }
      finally { db.close(); }
      expect(git(f.ownDir, 'status', '--porcelain')).not.toBe('');
      clock = 2_000;
      pending.push(runAutoSync({ ...opts, writeRequestedAt: 1_500 }), runAutoSync({ ...opts, writeRequestedAt: 1_500 }));
      release();
      const results = await Promise.all(pending);
      expect((await first).outcome?.own.disposition).toBe('success');
      expect(results.filter(result => result.ran)).toHaveLength(1);
      expect(results.filter(result => result.skipReason === 'write_already_synced')).toHaveLength(1);
      expect(probes).toBe(2);
      expect(git(f.ownDir, 'status', '--porcelain')).toBe('');
      expect(git(f.bare, 'rev-parse', 'main')).toBe(git(f.ownDir, 'rev-parse', 'HEAD'));
      expect(git(f.bare, 'show', 'main:entries/fixture.md')).toContain('updated while the first cycle holds its locks');
    } finally { release(); await Promise.allSettled([first, ...pending]); }
  });

  it('waits for the index lock without advancing state or removing the held lock', async () => {
    const f = fixture(); const lock = acquireFileLock(join(f.opts.caveatHome, 'index', '.reindex-lock'))!;
    const worker = runAutoSync({ ...f.opts, writeRequestedAt: 0 });
    let held = true;
    try {
      expect(readFileSync(lock.path, 'utf8')).toBe(String(process.pid));
      expect(existsSync(join(f.opts.caveatHome, 'sync', '.last-autosync.json'))).toBe(false);
      releaseFileLock(lock); held = false;
      expect((await worker).outcome?.own.disposition).toBe('success');
      expect(git(f.ownDir, 'status', '--porcelain')).toBe('');
    } finally { if (held) releaseFileLock(lock); await Promise.allSettled([worker]); }
  });

  it('bounds write lock waits and retains another cycle lock', async () => {
    const f = fixture(); const lock = acquireFileLock(join(f.opts.caveatHome, 'sync', '.autosync-lock'))!;
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(AUTO_SYNC_WRITE_LOCK_WAIT_MS);
    try {
      expect(await runAutoSync({ ...f.opts, writeRequestedAt: 0 })).toMatchObject({ ran: false, skipReason: 'write_lock_timeout' });
      expect(readFileSync(lock.path, 'utf8')).toBe(String(process.pid));
    } finally { clock.mockRestore(); releaseFileLock(lock); }
  });

  it('retains the last repository-busy outcome when the write wait expires', async () => {
    const f = fixture(); vi.mocked(syncOwn).mockRejectedValueOnce(new SyncError('SYNC_BUSY', 'fixture repository lock'));
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(AUTO_SYNC_WRITE_LOCK_WAIT_MS);
    try {
      expect(await runAutoSync({ ...f.opts, writeRequestedAt: 0 })).toMatchObject({ ran: true, skipReason: 'write_lock_timeout', outcome: { own: { code: 'SYNC_BUSY' } } });
    } finally { clock.mockRestore(); }
  });

  it('honors the off switch while a write worker is waiting', async () => {
    const f = fixture(); const lock = acquireFileLock(join(f.opts.caveatHome, 'sync', '.autosync-lock'))!;
    const worker = runAutoSync({ ...f.opts, writeRequestedAt: 0 });
    vi.stubEnv('CAVEAT_AUTO_SYNC', 'off');
    try {
      expect(await worker).toMatchObject({ ran: false, skipReason: 'disabled' });
      expect(readFileSync(lock.path, 'utf8')).toBe(String(process.pid));
    } finally { releaseFileLock(lock); }
  });

  it('does not use legacy state as completion proof', async () => {
    const f = fixture();
    writeAutoSyncState(f.opts.caveatHome, { finishedAt: new Date(5_000).toISOString(), signature: 'fixture', ownSync: { consecutiveFailureCount: 0, consecutiveFailureSignature: null } });
    expect((await runAutoSync({ ...f.opts, writeRequestedAt: 1_500, now: () => new Date(2_000) })).outcome?.own.disposition).toBe('success');
  });

  it('does not use a tied start time or another repository as completion proof', async () => {
    const f = fixture();
    expect((await runAutoSync({ ...f.opts, now: () => new Date(1_500) })).outcome?.own.disposition).toBe('success');
    expect((await runAutoSync({ ...f.opts, writeRequestedAt: 1_500, now: () => new Date(2_000) })).outcome?.own.disposition).toBe('success');
    writeFileSync(join(f.peer, 'entries', 'fixture.md'), entry('another configured knowledge repository'));
    const other = { ...f.opts, ownDir: f.peer, paths: { ...f.opts.paths, entriesDir: join(f.peer, 'entries') } };
    expect((await runAutoSync({ ...other, writeRequestedAt: 1_500, now: () => new Date(3_000) })).outcome?.own.disposition).toBe('success');
    expect(git(f.peer, 'status', '--porcelain')).toBe('');
    expect(git(f.bare, 'show', 'main:entries/fixture.md')).toContain('another configured knowledge repository');
  });

  it('does not retry a private-boundary refusal as a busy write', async () => {
    const f = fixture(); let probes = 0; writeFileSync(f.file, entry('private edit retained'));
    const head = git(f.ownDir, 'rev-parse', 'HEAD'); const status = git(f.ownDir, 'status', '--porcelain');
    const result = await runAutoSync({ ...f.opts, writeRequestedAt: 0, probeImpl: async () => { probes++; return { kind: 'anonymous-readable' }; } });
    expect(result.outcome?.own.code).toBe('REMOTE_PUBLIC'); expect(probes).toBe(1);
    expect(git(f.ownDir, 'rev-parse', 'HEAD')).toBe(head); expect(git(f.ownDir, 'status', '--porcelain')).toBe(status);
  });

  it('aborts a fixture conflict, retains the local commit and records failure', async () => {
    const f = fixture(); f.updatePeer('peer edit on the same line');
    writeFileSync(f.file, entry('local edit on the same line')); git(f.ownDir, 'add', '-A'); git(f.ownDir, 'commit', '-m', 'local input');
    const head = git(f.ownDir, 'rev-parse', 'HEAD');
    expect(await runPeriodicSync(f.opts)).toMatchObject({ status: 'failed', reason: 'sync_conflict' });
    expect(git(f.ownDir, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(f.file, 'utf8')).toContain('local edit on the same line');
    expect(existsSync(join(f.ownDir, '.git', 'rebase-merge'))).toBe(false);
    expect(readPeriodicSyncState(f.opts.caveatHome)?.last_failure?.reason).toBe('sync_conflict');
  });

  it('keeps a failure and prior success across a later busy skip', async () => {
    const f = fixture(); expect((await runPeriodicSync(f.opts)).status).toBe('success');
    const successAt = readPeriodicSyncState(f.opts.caveatHome)?.last_success_at;
    git(f.ownDir, 'remote', 'set-url', 'origin', join(f.root, 'missing.git'));
    expect((await runPeriodicSync(f.opts)).status).toBe('failed');
    const failed = readPeriodicSyncState(f.opts.caveatHome)?.last_failure;
    const lock = acquireFileLock(join(f.opts.caveatHome, 'sync', '.autosync-lock'))!;
    try { expect(await runPeriodicSync(f.opts)).toMatchObject({ status: 'skipped', reason: 'sync_busy' }); }
    finally { releaseFileLock(lock); }
    expect(readPeriodicSyncState(f.opts.caveatHome)).toMatchObject({ last_success_at: successAt, last_failure: failed, last_attempt: failed });
  });

  it('records index failure without reporting success or leaking error text', async () => {
    const f = fixture(); mkdirSync(join(f.opts.caveatHome, 'index'), { recursive: true });
    // The DB location is a directory, confined to this fixture.
    mkdirSync(f.opts.paths.dbPath);
    expect(await runPeriodicSync(f.opts)).toMatchObject({ status: 'failed', reason: 'cycle_failed' });
    const state = readPeriodicSyncState(f.opts.caveatHome)!;
    expect(state.last_success_at).toBeNull(); expect(state.last_failure?.reason).toBe('cycle_failed');
    expect(JSON.stringify(state)).not.toContain(f.root);
  });

  it('checks the interval under lock and preserves the last actual result', async () => {
    const f = fixture(); const instant = new Date('2026-10-15T00:00:00Z');
    expect((await runPeriodicSync({ ...f.opts, now: () => instant })).status).toBe('success');
    const attempt = readPeriodicSyncState(f.opts.caveatHome)?.last_attempt;
    expect(await runPeriodicSync({ ...f.opts, intervalMs: 900_000, now: () => instant })).toMatchObject({ status: 'skipped', reason: 'interval_wait' });
    expect(readPeriodicSyncState(f.opts.caveatHome)?.last_attempt).toEqual(attempt);
  });
});

afterEach(() => { vi.unstubAllEnvs(); });
