import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { SimpleGit } from 'simple-git';
import type { Logger } from './db.js';
import { openDb } from './db.js';
import { acquireFileLock, acquireReindexLock, computeEntriesDigest, reindexAllSources, releaseFileLock, writeDigestMarker, type FileLock } from './autoReindex.js';
import type { ResolvedPaths } from './paths.js';
import { deriveAnonymousProbeUrl, probeAnonymousRead, type RemoteAccess } from './remoteVisibility.js';
import { createGit } from './gitRuntime.js';
import { createKeyserverKeyProvider } from './sealedKeys.js';
import { normalizePathCase } from './platform.js';
import { prewarmSealedKeys } from './sealedIndex.js';

import { SyncError } from './syncErrors.js';
import { githubCredentialFailureCode, assertNamedGithubTargets } from './githubCredential.js';
export { SyncError, type SyncErrorCode } from './syncErrors.js';

/** A failed remote command is an observation, not proof of an app defect. */
export class SyncRemoteError extends Error {
  constructor(public readonly phase: 'inspect' | 'pull' | 'push' | 'fetch', cause: unknown) {
    super(`sync ${phase} did not complete; local entries are retained; remote result may be unknown: ${errorMessage(cause)}`, { cause });
    this.name = 'SyncRemoteError';
  }
}

export class SyncRecoveryError extends Error {
  constructor(cause: unknown) {
    super('sync recovery failed; inspect the local rebase before retrying', { cause });
    this.name = 'SyncRecoveryError';
  }
}

async function remoteOperation<T>(phase: SyncRemoteError['phase'], run: () => Promise<T>, githubUser?: string | null): Promise<T> {
  try { return await run(); } catch (cause) { const code = githubCredentialFailureCode(cause, githubUser); if (code) throw new SyncError(code, code); throw new SyncRemoteError(phase, cause); }
}

async function activeRebase(git: SimpleGit, ownDir: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const path = (await git.raw(['rev-parse', '--git-path', name])).trim();
    if (existsSync(resolve(ownDir, path))) return true;
  }
  return false;
}

export type ProbeImpl = (probeUrl: string | undefined) => Promise<RemoteAccess>;

export interface PreflightSyncOptions {
  githubUser?: string | null;
  trustRemotePrivate?: boolean;
  probeImpl?: ProbeImpl;
  gitTimeoutMs?: number;
}

export interface SyncPreflight {
  ownDir: string;
  branch: string;
  /** Every effective push URL (insteadOf/pushInsteadOf applied). git delivers to all of them. */
  pushUrls: string[];
  probe: RemoteAccess;
}

export interface SyncOwnOptions extends PreflightSyncOptions {
  ownDir: string;
  caveatHome: string;
  paths: Pick<ResolvedPaths, 'dbPath' | 'entriesDir' | 'communityDir'>;
  logger: Logger;
  dryRun?: boolean;
  /** Scheduled reception must never commit an editor's unfinished work. */
  dirtyPolicy?: 'commit' | 'refuse';
  /** Internal: the autosync cycle already owns this home's reindex lock. */
  heldReindexLock?: FileLock;
}

export interface SyncOwnResult extends SyncPreflight {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  dryRun: boolean;
  changedFiles: number;
}

export interface InitOwnSyncOptions extends PreflightSyncOptions {
  ownDir: string;
  url: string;
  caveatHome: string;
  paths: Pick<ResolvedPaths, 'dbPath' | 'entriesDir' | 'communityDir'>;
  logger: Logger;
}

export interface InitOwnSyncResult {
  ownDir: string;
  branch: string;
  remoteWasEmpty: boolean;
}

function normalizePath(path: string): string {
  return normalizePathCase(resolve(path).replace(/\\/g, '/'));
}

// git push delivers to EVERY push URL, not just the first. `--all` lists them
// all (insteadOf/pushInsteadOf applied); we must probe each — probing only the
// first lets a second, public pushurl receive private entries unchecked.
async function effectivePushUrls(git: SimpleGit): Promise<string[]> {
  let raw: string;
  try {
    raw = await git.raw(['remote', 'get-url', '--push', '--all', 'origin']);
  } catch {
    const remotes = (await git.raw(['remote'])).trim();
    const available = remotes ? remotes.split(/\r?\n/).join(', ') : '(none)';
    throw new SyncError('NO_REMOTE', `NO_REMOTE: origin is required (configured remotes: ${available})`);
  }
  const urls = raw.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new SyncError('NO_REMOTE', 'NO_REMOTE: origin has no push URL');
  return urls;
}

// A remote is safe to push private data to only if EVERY push URL is
// non-public. Fail closed: any anonymous-readable URL rejects outright; any
// unverifiable URL requires explicit trust.
async function assertPrivateRemotes(
  remoteUrls: string[],
  opts: PreflightSyncOptions,
): Promise<RemoteAccess> {
  const probe = opts.probeImpl ?? probeAnonymousRead;
  let worst: RemoteAccess = { kind: 'denied', status: 0 };
  for (const remoteUrl of remoteUrls) {
    const result = await probe(deriveAnonymousProbeUrl(remoteUrl));
    if (result.kind === 'anonymous-readable') {
      throw new SyncError('REMOTE_PUBLIC', `remote is anonymously readable: ${remoteUrl}`);
    }
    if (result.kind === 'indeterminate') {
      if (!opts.trustRemotePrivate) {
        throw new SyncError(
          'REMOTE_VISIBILITY_INDETERMINATE',
          `could not verify remote privacy: ${remoteUrl}; rerun with --trust-remote-private to accept this risk`,
        );
      }
      worst = result;
    }
  }
  return worst;
}

function requireOwnDirectory(ownDir: string): void {
  if (!statSync(ownDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new SyncError('NOT_A_REPO', 'own knowledge directory is missing or not a directory; configure the intended repository for this client context before syncing');
  }
}

/** Validate that ownDir is exactly the checked-out worktree root and safe to push. */
export async function preflightSync(
  ownDir: string,
  opts: PreflightSyncOptions = {},
): Promise<SyncPreflight> {
  requireOwnDirectory(ownDir);
  const git = createGit(ownDir, { timeoutMs: opts.gitTimeoutMs, githubUser: opts.githubUser });
  if (!(await git.checkIsRepo())) {
    throw new SyncError('NOT_A_REPO', 'own knowledge directory is not a git repository; run `caveat sync --init` first');
  }

  // realpathSync.native expands Windows 8.3 short names (RUNNER~1 → runneradmin),
  // which plain realpathSync does not — git returns the long form for
  // --show-toplevel, so comparing without expansion false-positives
  // EXTERNAL_TOPLEVEL whenever the path came in as a short name (CI temp dirs).
  const root = realpathSync.native((await git.revparse(['--show-toplevel'])).trim());
  const requested = realpathSync.native(ownDir);
  if (normalizePath(root) !== normalizePath(requested)) {
    throw new SyncError('EXTERNAL_TOPLEVEL', `EXTERNAL_TOPLEVEL: own directory must be the repository root: ${requested} (root: ${root})`);
  }

  if (await activeRebase(git, requested)) {
    throw new SyncError('REBASE_IN_PROGRESS', 'a rebase is already active; inspect and finish or abort it before syncing');
  }

  // symbolic-ref succeeds on an unborn branch (fresh init, no commits yet),
  // where `rev-parse --abbrev-ref HEAD` errors out. It fails on detached HEAD.
  let branch: string;
  try {
    branch = (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    throw new SyncError('DETACHED_HEAD', 'cannot sync from a detached HEAD');
  }

  const pushUrls = await effectivePushUrls(git);
  if (opts.githubUser != null) assertNamedGithubTargets([...pushUrls, (await git.raw(['remote', 'get-url', 'origin'])).trim()], opts.githubUser);
  const probe = await assertPrivateRemotes(pushUrls, opts);
  return { ownDir: requested, branch, pushUrls, probe };
}

async function reindexAndMark(opts: Pick<SyncOwnOptions, 'caveatHome' | 'paths' | 'logger'>): Promise<void> {
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

export async function syncOwn(opts: SyncOwnOptions): Promise<SyncOwnResult> {
  // All sync entry points take index then repository locks. The repository lock
  // lives in Git's common directory, so different CAVEAT_HOMEs/worktrees agree.
  const indexLock = opts.heldReindexLock ?? acquireReindexLock(opts.caveatHome);
  if (!indexLock) throw new SyncError('SYNC_BUSY', 'reindex is already running; retry later');
  let repoLock: FileLock | null = null;
  try {
    requireOwnDirectory(opts.ownDir);
    const git = createGit(opts.ownDir, { timeoutMs: opts.gitTimeoutMs, githubUser: opts.githubUser });
    if (await git.checkIsRepo()) {
      const common = realpathSync.native(resolve(opts.ownDir, (await git.raw(['rev-parse', '--git-common-dir'])).trim()));
      repoLock = acquireFileLock(join(common, '.caveat-sync-lock'));
      if (!repoLock) throw new SyncError('SYNC_BUSY', 'this knowledge repository is already syncing; retry later');
      if (opts.dirtyPolicy === 'refuse' && !(await git.status()).isClean()) {
        throw new SyncError('WORKTREE_DIRTY', 'scheduled sync retained uncommitted changes; retry after editing');
      }
    }
    return await syncOwnLocked(opts);
  } finally {
    if (repoLock) releaseFileLock(repoLock);
    if (!opts.heldReindexLock) releaseFileLock(indexLock);
  }
}

async function syncOwnLocked(opts: SyncOwnOptions): Promise<SyncOwnResult> {
  const preflight = await preflightSync(opts.ownDir, opts);
  const git = createGit(preflight.ownDir, { timeoutMs: opts.gitTimeoutMs, githubUser: opts.githubUser });
  const status = await git.status();
  if (opts.dirtyPolicy === 'refuse' && !status.isClean()) {
    throw new SyncError('WORKTREE_DIRTY', 'scheduled sync retained uncommitted changes; retry after editing');
  }
  if (opts.dryRun) {
    return {
      ...preflight,
      committed: false,
      pulled: false,
      pushed: false,
      dryRun: true,
      changedFiles: status.files.length,
    };
  }
  let committed = false;
  if (!status.isClean()) {
    await git.add('-A');
    const changed = status.files.length;
    await git.commit(`caveat sync: ${changed} changed file${changed === 1 ? '' : 's'}`);
    committed = true;
  }

  const remoteBranch = (await remoteOperation('inspect', () => git.raw(['ls-remote', '--heads', 'origin', preflight.branch]), opts.githubUser)).trim();
  let pulled = false;
  if (remoteBranch) {
    try {
      await git.pull('origin', preflight.branch, opts.dirtyPolicy === 'refuse' ? ['--rebase', '--no-autostash'] : ['--rebase']);
      pulled = true;
    } catch (err) {
      // Pull may fail before rebase starts. Do not call every transport error
      // a conflict, or claim recovery succeeded if an active rebase remains.
      let rebasing: boolean;
      try { rebasing = await activeRebase(git, preflight.ownDir); } catch (cause) { throw new SyncRecoveryError(cause); }
      if (!rebasing) { const code = githubCredentialFailureCode(err, opts.githubUser); if (code) throw new SyncError(code, code); throw new SyncRemoteError('pull', err); }
      try {
        await git.raw(['rebase', '--abort']);
        if (await activeRebase(git, preflight.ownDir)) throw Error('rebase still active');
      } catch (cause) { throw new SyncRecoveryError(cause); }
      const detail = err instanceof Error ? err.message : String(err);
      throw new SyncError('SYNC_CONFLICT', `sync rebase failed and was aborted: ${detail}`);
    }
  }

  if (opts.dirtyPolicy === 'refuse' && !(await git.status()).isClean()) {
    throw new SyncError('WORKTREE_DIRTY', 'scheduled sync retained edits made during reception');
  }
  await reindexAndMark(opts);
  await remoteOperation('push', () => git.push('origin', preflight.branch, ['-u']), opts.githubUser);
  return {
    ...preflight,
    committed,
    pulled,
    pushed: true,
    dryRun: false,
    changedFiles: status.files.length,
  };
}

// Canonical .gitignore scaffold for the own knowledge repo. The CLI init
// command imports this — keep a single source of truth (docs/06 C8).
export const KNOWLEDGE_GITIGNORE = [
  '# Private entries DO sync to your private remote (Caveat-Private) — that is the',
  '# intended sharing boundary. The public boundary is enforced by `caveat publish`.',
  '',
  '# Obsidian per-user config: workspace layout, theme, plugin state, cache.',
  '.obsidian/',
  '',
  '# Editor / OS scratch files that should never sync.',
  '.DS_Store',
  '*.swp',
  '*~',
  '',
].join('\n');

function countMarkdownEntries(ownDir: string): number {
  const entries = join(ownDir, 'entries');
  if (!existsSync(entries)) return 0;
  let count = 0;
  const stack = [entries];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) count++;
    }
  }
  return count;
}

function scaffold(ownDir: string): void {
  mkdirSync(join(ownDir, 'entries'), { recursive: true });
  const gitignore = join(ownDir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, KNOWLEDGE_GITIGNORE, 'utf-8');
}

function removeCanonicalScaffoldBeforeCheckout(ownDir: string): void {
  const gitignore = join(ownDir, '.gitignore');
  if (existsSync(gitignore) && readFileSync(gitignore, 'utf-8') === KNOWLEDGE_GITIGNORE) {
    rmSync(gitignore);
  }
}

async function defaultRemoteBranch(git: SimpleGit, url: string, githubUser?: string | null): Promise<string> {
  const symref = await remoteOperation('inspect', () => git.raw(['ls-remote', '--symref', url, 'HEAD']), githubUser);
  const match = /^ref: refs\/heads\/([^\s]+)\s+HEAD$/m.exec(symref);
  if (match) return match[1]!;
  const heads = await remoteOperation('inspect', () => git.raw(['ls-remote', '--heads', url]), githubUser);
  const first = /refs\/heads\/([^\s]+)\s*$/m.exec(heads);
  if (!first) throw new Error(`remote has refs but no branch heads: ${url}`);
  return first[1]!;
}

export async function initOwnSync(opts: InitOwnSyncOptions): Promise<InitOwnSyncResult> {
  assertNamedGithubTargets([opts.url], opts.githubUser);
  const ownDir = resolve(opts.ownDir);
  // A fresh install has no own dir yet — create it before any git inspection
  // (simple-git refuses to start in a directory that does not exist).
  mkdirSync(ownDir, { recursive: true });
  const existing = createGit(ownDir, { githubUser: opts.githubUser });
  if (await existing.checkIsRepo()) {
    throw new SyncError('OWN_REPO_EXISTS', `own knowledge directory is already a git repository: ${ownDir}`);
  }

  const inspector = createGit(ownDir, { githubUser: opts.githubUser });
  if (opts.githubUser != null) assertNamedGithubTargets([(await inspector.raw(['ls-remote', '--get-url', opts.url])).trim()], opts.githubUser);
  const refs = (await remoteOperation('inspect', () => inspector.raw(['ls-remote', '--heads', opts.url]), opts.githubUser)).trim();
  const entryCount = countMarkdownEntries(ownDir);
  if (refs && entryCount > 0) {
    throw new SyncError('BOTH_HAVE_ENTRIES', 'local and remote both contain entries; resolve the ownership conflict before initializing sync');
  }

  const git = createGit(ownDir, { githubUser: opts.githubUser });
  const createdGitDir = join(ownDir, '.git');
  await git.init();
  try {
    await git.addRemote('origin', opts.url);
    // Probe the EFFECTIVE push URL (insteadOf/pushInsteadOf applied), not the
    // raw opts.url — the rewrite can point push at a different, public host.
    const pushUrls = await effectivePushUrls(git);
    assertNamedGithubTargets(pushUrls, opts.githubUser);
    await assertPrivateRemotes(pushUrls, opts);

    if (!refs) {
      scaffold(ownDir);
      await git.add('-A');
      await git.commit(`caveat sync: initial import (${entryCount} entries)`);
      const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      await remoteOperation('push', () => git.push('origin', branch, ['-u']), opts.githubUser);
      await reindexAndMark(opts);
      return { ownDir, branch, remoteWasEmpty: true };
    }

    const branch = await defaultRemoteBranch(git, opts.url, opts.githubUser);
    await remoteOperation('fetch', () => git.fetch('origin', branch), opts.githubUser);
    // `caveat init --sync` scaffolds this exact file before it discovers an
    // existing remote. Remove only the product-generated byte-for-byte copy so
    // checkout can restore the remote's tracked scaffold without overwriting
    // any user-authored file.
    removeCanonicalScaffoldBeforeCheckout(ownDir);
    await git.checkout(['--track', '-B', branch, `origin/${branch}`]);
    await reindexAndMark(opts);
    return { ownDir, branch, remoteWasEmpty: false };
  } catch (err) {
    // Roll the half-initialized .git back so a re-run isn't permanently blocked
    // by OWN_REPO_EXISTS. Only remove the .git we just created; leave entries.
    try {
      rmSync(createdGitDir, { recursive: true, force: true });
    } catch (cause) { throw new SyncRecoveryError(cause); }
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
