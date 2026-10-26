import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SyncError, type SyncErrorCode } from './syncErrors.js';

const accountCodes = ['CAVEAT_GITHUB_CONFIG_UNSUPPORTED', 'CAVEAT_GITHUB_USER_INVALID', 'CAVEAT_GITHUB_USER_UNAVAILABLE', 'CAVEAT_GITHUB_USERNAME_MISMATCH', 'CAVEAT_GITHUB_TARGET_UNSUPPORTED', 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE', 'CAVEAT_GITHUB_CLI_UNAVAILABLE', 'CAVEAT_GITHUB_CLI_UNSUPPORTED', 'CAVEAT_GITHUB_CREDENTIAL_EXPIRED'] as const;
export function validateGithubUser(user: unknown): string {
  if (typeof user !== 'string' || user.length > 39 || user !== user.trim() || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(user)) throw new SyncError('CAVEAT_GITHUB_USER_INVALID', 'CAVEAT_GITHUB_USER_INVALID');
  return user;
}
export function githubCredentialFailureCode(error: unknown, user?: string | null): SyncErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return accountCodes.find(code => message.includes(code)) ?? (user != null && /transport .* not allowed/i.test(message) ? 'CAVEAT_GITHUB_TARGET_UNSUPPORTED' : undefined) ?? (user != null && /Authentication failed|Bad credentials|HTTP 401|returned error: 401/i.test(message) ? 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE' : undefined);
}
/** Git runs credential shell snippets through sh on all three supported OSes. */
export function githubGitConfig(user?: string | null, baseDir?: string, inherited: NodeJS.ProcessEnv = process.env): string[] {
  if (user == null) return [];
  const selected = validateGithubUser(user);
  const quote = (value: string) => "'" + value.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
  const helper = fileURLToPath(new URL('./githubCredentialHelper.js', import.meta.url));
  return ['credential.helper=', 'credential.https://github.com.helper=',
    ...namedConfigurationResets(baseDir, githubGitEnvironment(selected, inherited)),
    `credential.https://github.com.helper=!${quote(process.execPath)} ${quote(helper)} ${quote(selected)}`,
    `credential.https://github.com.username=${selected}`,
    'credential.interactive=false', 'protocol.allow=never', 'protocol.https.allow=always', 'http.extraHeader=', 'http.https://github.com/.extraHeader='];
}
export function githubGitEnvironment(user?: string | null, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (user == null) return inherited;
  validateGithubUser(user);
  // A failed named helper must not fall through to an inherited askpass helper.
  const env: NodeJS.ProcessEnv = { ...inherited, GIT_ASKPASS: '', SSH_ASKPASS: '' };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_CONFIG') || key.toUpperCase().startsWith('GIT_TRACE') || key.toUpperCase() === 'GIT_CURL_VERBOSE') delete env[key];
  delete env.GIT_PROTOCOL_FROM_USER;
  env.GIT_ALLOW_PROTOCOL = 'https';
  return env;
}

export function assertNamedGithubTargets(urls: string[], user?: string | null): void {
  if (user == null) return;
  validateGithubUser(user);
  for (const value of urls) {
    let url: URL;
    try { url = new URL(value); } catch { throw new SyncError('CAVEAT_GITHUB_TARGET_UNSUPPORTED', 'CAVEAT_GITHUB_TARGET_UNSUPPORTED'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password)
      throw new SyncError('CAVEAT_GITHUB_TARGET_UNSUPPORTED', 'CAVEAT_GITHUB_TARGET_UNSUPPORTED');
  }
}

// Read names only; no user-provided helper/protocol value enters the opted-in instance.
function namedConfigurationResets(baseDir: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const result = spawnSync('git', [...(baseDir ? ['-C', baseDir] : []), 'config', '--name-only', '--get-regexp', '^(core\\.askpass|credential(\\..*)?\\.helper|protocol(\\..*)?\\.allow|http(\\..*)?\\.extraheader)$'],
    { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536, windowsHide: true });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new SyncError('CAVEAT_GITHUB_CONFIG_UNSUPPORTED', 'CAVEAT_GITHUB_CONFIG_UNSUPPORTED');
  return [...new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean))].map(key => {
    if (/^credential(?:\.[A-Za-z0-9:/._-]+)?\.helper$/i.test(key)) return `${key}=`;
    if (/^http(?:\.[A-Za-z0-9:/._-]+)?\.extraheader$/i.test(key)) return `${key}=`;
    if (/^protocol(?:\.[A-Za-z0-9_-]+)?\.allow$/i.test(key)) return `${key}=never`;
    throw new SyncError('CAVEAT_GITHUB_CONFIG_UNSUPPORTED', 'CAVEAT_GITHUB_CONFIG_UNSUPPORTED');
  });
}
