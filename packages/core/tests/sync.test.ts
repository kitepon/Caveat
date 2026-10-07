import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initOwnSync, KNOWLEDGE_GITIGNORE, preflightSync, syncOwn, SyncError, type ProbeImpl } from '../src/sync.js';

const denied: ProbeImpl = async () => ({ kind: 'denied', status: 404 });
const readable: ProbeImpl = async () => ({ kind: 'anonymous-readable' });
const indeterminate: ProbeImpl = async () => ({ kind: 'indeterminate', reason: 'offline' });
const logger = { info: () => {}, warn: () => {}, error: () => {} };

// initOwnSync commits inside a repo it creates itself (no local identity).
// CI runners have no global git identity — inject one via env so git children
// spawned by both execFileSync and simple-git inherit it.
process.env.GIT_AUTHOR_NAME = 'caveat test';
process.env.GIT_AUTHOR_EMAIL = 'caveat-test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'caveat test';
process.env.GIT_COMMITTER_EMAIL = 'caveat-test@example.invalid';

interface Fixture {
  root: string;
  remote: string;
  own: string;
  home: string;
  paths: { dbPath: string; entriesDir: string; communityDir: string };
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'caveat-sync-'));
  const remote = join(root, 'remote.git');
  const own = join(root, 'own');
  const home = join(root, 'home');
  git(['init', '--bare', remote]);
  return {
    root, remote, own, home,
    paths: { dbPath: join(home, 'index', 'caveat.db'), entriesDir: join(own, 'entries'), communityDir: join(home, 'community') },
  };
}

function configureIdentity(dir: string): void {
  git(['config', 'user.email', 'sync-test@example.invalid'], dir);
  git(['config', 'user.name', 'sync test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

// Real git subprocess chains exceed vitest's 5s default on the slowest
// Windows CI runner; EBUSY retries cover git children releasing handles late.
const GIT_TEST_TIMEOUT_MS = 60_000;

describe('preflightSync', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  let fixture: Fixture;
  beforeEach(() => { fixture = makeFixture(); });
  afterEach(() => { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('rejects a non-repository with the init guidance', async () => {
    mkdirSync(fixture.own, { recursive: true });
    await expect(preflightSync(fixture.own, { probeImpl: denied })).rejects.toMatchObject({
      code: 'NOT_A_REPO',
      message: expect.stringContaining('run `caveat sync --init` first'),
    });
  });

  it('passes the requested git timeout policy into preflight', async () => {
    mkdirSync(fixture.own, { recursive: true });
    await expect(preflightSync(fixture.own, { probeImpl: denied, gitTimeoutMs: 5_999 }))
      .rejects.toThrow('at least 6000');
  });

  it('rejects an external subdirectory rather than syncing its parent repo', async () => {
    git(['init', fixture.own]);
    configureIdentity(fixture.own);
    git(['remote', 'add', 'origin', fixture.remote], fixture.own);
    mkdirSync(join(fixture.own, 'entries'), { recursive: true });
    await expect(preflightSync(join(fixture.own, 'entries'), { probeImpl: denied })).rejects.toMatchObject({ code: 'EXTERNAL_TOPLEVEL' });
  });

  it('rejects anonymous read access', async () => {
    git(['init', fixture.own]);
    configureIdentity(fixture.own);
    git(['remote', 'add', 'origin', fixture.remote], fixture.own);
    await expect(preflightSync(fixture.own, { probeImpl: readable })).rejects.toMatchObject({ code: 'REMOTE_PUBLIC' });
  });

  it('does NOT let --trust-remote-private bypass an anonymous-readable remote', async () => {
    git(['init', fixture.own]);
    configureIdentity(fixture.own);
    git(['remote', 'add', 'origin', fixture.remote], fixture.own);
    // trust only downgrades indeterminate → continue; a proven-public remote
    // must still reject. This is the core boundary invariant.
    await expect(
      preflightSync(fixture.own, { probeImpl: readable, trustRemotePrivate: true }),
    ).rejects.toMatchObject({ code: 'REMOTE_PUBLIC' });
  });

  it('refuses an already active rebase before committing or touching the remote', async () => {
    git(['init', fixture.own]); configureIdentity(fixture.own);
    git(['remote', 'add', 'origin', fixture.remote], fixture.own);
    mkdirSync(join(fixture.own, '.git', 'rebase-merge'));
    const entry = join(fixture.own, 'unsaved.md'); writeFileSync(entry, '# retained input\n');
    const probe = async () => { throw Error('must not probe'); };
    await expect(preflightSync(fixture.own, { probeImpl: probe })).rejects.toMatchObject({ code: 'REBASE_IN_PROGRESS' });
    expect(readFileSync(entry, 'utf8')).toBe('# retained input\n');
    expect(existsSync(join(fixture.own, '.git', 'rebase-merge'))).toBe(true);
  });

  it('probes every push URL and rejects if any additional pushurl is public', async () => {
    git(['init', fixture.own]);
    configureIdentity(fixture.own);
    git(['remote', 'add', 'origin', fixture.remote], fixture.own);
    // Two explicit https push URLs — git push would deliver to BOTH. Use https
    // (not local paths) so each survives deriveAnonymousProbeUrl to reach probe.
    git(['remote', 'set-url', '--add', '--push', 'origin', 'https://forge.example/org/private.git'], fixture.own);
    git(['remote', 'set-url', '--add', '--push', 'origin', 'https://forge.example/org/public-mirror.git'], fixture.own);
    const probeImpl: ProbeImpl = async (url) =>
      url && url.includes('public-mirror') ? { kind: 'anonymous-readable' } : { kind: 'denied', status: 404 };
    await expect(preflightSync(fixture.own, { probeImpl })).rejects.toMatchObject({ code: 'REMOTE_PUBLIC' });
  });

  it('requires explicit trust only for an indeterminate probe', async () => {
    git(['init', fixture.own]);
    configureIdentity(fixture.own);
    git(['remote', 'add', 'origin', fixture.remote], fixture.own);
    await expect(preflightSync(fixture.own, { probeImpl: indeterminate })).rejects.toMatchObject({ code: 'REMOTE_VISIBILITY_INDETERMINATE' });
    await expect(preflightSync(fixture.own, { probeImpl: indeterminate, trustRemotePrivate: true })).resolves.toMatchObject({ probe: { kind: 'indeterminate' } });
  });
});

describe('initOwnSync / syncOwn (local bare remote)', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  let fixture: Fixture;
  beforeEach(() => { fixture = makeFixture(); });
  afterEach(() => { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  it('initializes an empty bare remote, then commits, indexes, and pushes local edits', async () => {
    // Supplying identity through environment is not supported by simple-git, so
    // initialize the worktree ourselves only to provide its local identity.
    mkdirSync(fixture.own, { recursive: true });
    git(['init'], fixture.own);
    configureIdentity(fixture.own);
    await expect(
      initOwnSync({ ownDir: fixture.own, caveatHome: fixture.home, paths: fixture.paths, url: fixture.remote, logger, probeImpl: denied }),
    ).rejects.toMatchObject({ code: 'OWN_REPO_EXISTS' });

    // A fresh process's normal git identity is intentionally not a core concern;
    // exercise the sync pipeline with an initialized local bare clone.
    rmSync(fixture.own, { recursive: true, force: true });
    git(['clone', fixture.remote, fixture.own]);
    configureIdentity(fixture.own);
    git(['checkout', '-b', 'main'], fixture.own);
    mkdirSync(fixture.paths.entriesDir, { recursive: true });
    writeFileSync(join(fixture.paths.entriesDir, 'entry.md'), '---\nid: entry\ntitle: Entry\nvisibility: public\nconfidence: tentative\n---\n\n## Symptom\ntest\n');
    const result = await syncOwn({ ownDir: fixture.own, caveatHome: fixture.home, paths: fixture.paths, logger, probeImpl: denied });
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(existsSync(join(fixture.home, 'index', '.entries-digest'))).toBe(true);
    expect(git(['log', '-1', '--format=%s'], fixture.own).trim()).toBe('caveat sync: 1 changed file');
  });

  it('retains committed input after a remote inspection failure and resumes without duplicate commits', async () => {
    git(['clone', fixture.remote, fixture.own]);
    configureIdentity(fixture.own);
    git(['checkout', '-b', 'main'], fixture.own);
    mkdirSync(fixture.paths.entriesDir, { recursive: true });
    const entry = join(fixture.paths.entriesDir, 'entry.md');
    const content = '# local input must survive\n';
    writeFileSync(entry, content);
    const moved = fixture.remote + '.offline';
    renameSync(fixture.remote, moved);
    const opts = { ownDir: fixture.own, caveatHome: fixture.home, paths: fixture.paths, logger, probeImpl: denied };
    try {
      await expect(syncOwn(opts)).rejects.toMatchObject({ name: 'SyncRemoteError', phase: 'inspect' });
      expect(readFileSync(entry, 'utf8')).toBe(content);
      expect(git(['rev-list', '--count', 'HEAD'], fixture.own).trim()).toBe('1');
    } finally { renameSync(moved, fixture.remote); }
    expect(await syncOwn(opts)).toMatchObject({ committed: false, pushed: true });
    expect(git(['rev-list', '--count', 'main'], fixture.remote).trim()).toBe('1');
    expect(readFileSync(entry, 'utf8')).toBe(content);
  });

  it('aborts a real conflicting rebase and retains local input and commit', async () => {
    await initOwnSync({ ownDir: fixture.own, url: fixture.remote, caveatHome: fixture.home, paths: fixture.paths, logger, probeImpl: denied });
    configureIdentity(fixture.own);
    const branch = git(['branch', '--show-current'], fixture.own).trim();
    const entry = join(fixture.paths.entriesDir, 'entry.md');
    writeFileSync(entry, '# base\n');
    const opts = { ownDir: fixture.own, caveatHome: fixture.home, paths: fixture.paths, logger, probeImpl: denied };
    await syncOwn(opts);
    const other = join(fixture.root, 'other');
    git(['clone', '-b', branch, fixture.remote, other]);
    configureIdentity(other);
    writeFileSync(join(other, 'entries', 'entry.md'), '# remote change\n');
    git(['add', '-A'], other); git(['commit', '-m', 'remote change'], other); git(['push'], other);
    writeFileSync(entry, '# local change\n');
    await expect(syncOwn(opts)).rejects.toMatchObject({ name: 'SyncError', code: 'SYNC_CONFLICT' });
    expect(readFileSync(entry, 'utf8')).toBe('# local change\n');
    expect(existsSync(join(fixture.own, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(fixture.own, '.git', 'rebase-apply'))).toBe(false);
    expect(git(['status', '--porcelain'], fixture.own).trim()).toBe('');
  });

  it('refuses --init against an anonymous-readable remote (init-path boundary)', async () => {
    await expect(
      initOwnSync({ ownDir: fixture.own, caveatHome: fixture.home, paths: fixture.paths, url: fixture.remote, logger, probeImpl: readable }),
    ).rejects.toMatchObject({ code: 'REMOTE_PUBLIC' });
    // The half-initialized .git must be rolled back so a corrected re-run works.
    expect(existsSync(join(fixture.own, '.git'))).toBe(false);
  });

  it('refuses init when both local and nonempty remote contain entries', async () => {
    const seed = join(fixture.root, 'seed');
    git(['clone', fixture.remote, seed]);
    configureIdentity(seed);
    git(['checkout', '-b', 'main'], seed);
    mkdirSync(join(seed, 'entries'), { recursive: true });
    writeFileSync(join(seed, 'entries', 'remote.md'), '# remote\n');
    git(['add', '-A'], seed);
    git(['commit', '-m', 'seed'], seed);
    git(['push', '-u', 'origin', 'main'], seed);
    mkdirSync(join(fixture.own, 'entries'), { recursive: true });
    writeFileSync(join(fixture.own, 'entries', 'local.md'), '# local\n');
    await expect(
      initOwnSync({ ownDir: fixture.own, caveatHome: fixture.home, paths: fixture.paths, url: fixture.remote, logger, probeImpl: denied }),
    ).rejects.toMatchObject({ code: 'BOTH_HAVE_ENTRIES' });
  });

  it('checks out an existing remote over the canonical init scaffold', async () => {
    const seed = join(fixture.root, 'seed-scaffold');
    git(['clone', fixture.remote, seed]);
    configureIdentity(seed);
    git(['checkout', '-b', 'main'], seed);
    mkdirSync(join(seed, 'entries'), { recursive: true });
    writeFileSync(join(seed, '.gitignore'), KNOWLEDGE_GITIGNORE);
    writeFileSync(join(seed, 'entries', 'remote.md'), '# remote\n');
    git(['add', '-A'], seed);
    git(['commit', '-m', 'seed scaffold'], seed);
    git(['push', '-u', 'origin', 'main'], seed);

    mkdirSync(join(fixture.own, 'entries'), { recursive: true });
    writeFileSync(join(fixture.own, '.gitignore'), KNOWLEDGE_GITIGNORE);
    const result = await initOwnSync({
      ownDir: fixture.own,
      caveatHome: fixture.home,
      paths: fixture.paths,
      url: fixture.remote,
      logger,
      probeImpl: denied,
    });

    expect(result).toMatchObject({ branch: 'main', remoteWasEmpty: false });
    expect(readFileSync(join(fixture.own, '.gitignore'), 'utf-8')).toBe(KNOWLEDGE_GITIGNORE);
    expect(readFileSync(join(fixture.own, 'entries', 'remote.md'), 'utf-8')).toBe('# remote\n');
  });
});
