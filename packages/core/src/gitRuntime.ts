import { parseEnv } from '@simple-git/argv-parser';
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import { githubGitConfig, githubGitEnvironment, validateGithubUser } from './githubCredential.js';
import { isWindows } from './platform.js';
import { SyncError } from './syncErrors.js';

// simple-git timeout.block is an inactivity timeout: the git process is killed
// only after stdout/stderr have been silent for this long. It is not a total
// elapsed-time cap. Foreground CLI work gets enough room for large clone/push.
export const FOREGROUND_GIT_TIMEOUT_MS = 300_000;

// simple-git timeout.block is an inactivity timeout, not a total elapsed-time
// cap. Background hook workers should give up quickly and retry on a later
// opportunity instead of hanging a detached process indefinitely.
export const BACKGROUND_GIT_TIMEOUT_MS = 30_000;

const HTTP_HELPER_PREEMPT_MARGIN_MS = 5_000;
const MIN_GIT_TIMEOUT_MS = HTTP_HELPER_PREEMPT_MARGIN_MS + 1_000;

export function createGit(baseDir?: string, opts?: { timeoutMs?: number; githubUser?: string | null }): SimpleGit {
  const timeoutMs = opts?.timeoutMs ?? FOREGROUND_GIT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_GIT_TIMEOUT_MS) {
    throw new Error(`git timeoutMs must be at least ${MIN_GIT_TIMEOUT_MS}`);
  }
  // Let git-remote-http fail through Git's normal parent/child path before
  // simple-git has to interrupt only the direct git child. This avoids leaving
  // the helper orphaned on Node 22/Windows for a connected but silent server.
  const lowSpeedTimeSeconds = Math.floor((timeoutMs - HTTP_HELPER_PREEMPT_MARGIN_MS) / 1_000);
  const env = {
    ...nonInteractiveGitEnvironment(opts?.githubUser),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    // Git's GIT_HTTP_LOW_SPEED_* environment variables override the matching
    // config keys. Set both after inherited env so a caller cannot silently
    // disable the helper-side no-response bound.
    GIT_HTTP_LOW_SPEED_LIMIT: '1',
    GIT_HTTP_LOW_SPEED_TIME: String(lowSpeedTimeSeconds),
  };
  const options: Partial<SimpleGitOptions> = {
    maxConcurrentProcesses: 1,
    timeout: { block: timeoutMs },
    // On Windows, killing the direct `git` child does not necessarily kill its
    // `git-remote-http` descendant. This earlier HTTP transfer-rate bound lets
    // Git unwind its own helper first; it is not a general process-tree or
    // total elapsed-time guarantee.
    config: [
      ...githubGitConfig(opts?.githubUser, baseDir, env),
      // Windowsの長いentryパスを扱う。ユーザーのGit設定は変更しない。
      ...(isWindows() ? ['core.longpaths=true'] : []),
      'http.lowSpeedLimit=1',
      `http.lowSpeedTime=${lowSpeedTimeSeconds}`,
    ],
    // Opt in only for the validated product helper and its HTTPS-only protocol policy.
    allowEnvironment: Object.keys(env).filter(key => /^GIT_/i.test(key)),
    unsafe: opts?.githubUser == null ? {} : { allowUnsafeCredentialHelper: true, allowUnsafeProtocolOverride: true },
  };
  const git = baseDir === undefined ? simpleGit(options) : simpleGit(baseDir, options);
  return git.env(env);
}

const supportedGitEnvironment = new Set([
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
  'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_SSL_NO_VERIFY',
  'GIT_TERMINAL_PROMPT', 'GIT_HTTP_LOW_SPEED_LIMIT', 'GIT_HTTP_LOW_SPEED_TIME',
]);

/** Validate before naming/scrubbing: inherited command/config opt-ins are never inferred. */
function nonInteractiveGitEnvironment(user?: string | null): NodeJS.ProcessEnv {
  if (user != null) validateGithubUser(user);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(EDITOR|VISUAL|GIT_EDITOR|GIT_SEQUENCE_EDITOR|PAGER|GIT_PAGER|GIT_CURL_VERBOSE|GH_DEBUG)$/i.test(key) || /^GIT_TRACE/i.test(key)) delete env[key];
  const categories = new Set(parseEnv(env).vulnerabilities.map(v => v.category as string));
  const unsupported = Object.keys(env).filter(key => /^GIT_/i.test(key) && !supportedGitEnvironment.has(key.toUpperCase()));
  if (unsupported.length) categories.add('unreviewedGitEnvironment');
  if (categories.size) throw new SyncError('CAVEAT_GIT_ENV_UNSAFE', `CAVEAT_GIT_ENV_UNSAFE (${[...categories].sort().join(', ')}); remove unreviewed Git environment overrides`);
  const child = { ...githubGitEnvironment(user, env) };
  // Named credentials disable askpass in Git config; do not opt in to an editor/helper environment.
  delete child.GIT_ASKPASS; delete child.SSH_ASKPASS;
  return child;
}
