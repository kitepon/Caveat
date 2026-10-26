import { fileURLToPath } from 'node:url';
import { SyncError, type SyncErrorCode } from './syncErrors.js';

const accountCodes = ['CAVEAT_GITHUB_USER_INVALID', 'CAVEAT_GITHUB_USER_UNAVAILABLE', 'CAVEAT_GITHUB_USERNAME_MISMATCH', 'CAVEAT_GITHUB_TARGET_UNSUPPORTED', 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE', 'CAVEAT_GITHUB_CLI_UNAVAILABLE', 'CAVEAT_GITHUB_CLI_UNSUPPORTED', 'CAVEAT_GITHUB_CREDENTIAL_EXPIRED'] as const;
export function validateGithubUser(user: unknown): string {
  if (typeof user !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user)) throw new SyncError('CAVEAT_GITHUB_USER_INVALID', 'CAVEAT_GITHUB_USER_INVALID');
  return user;
}
export function githubCredentialFailureCode(error: unknown, user?: string | null): SyncErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return accountCodes.find(code => message.includes(code)) ?? (user != null && /transport .* not allowed/i.test(message) ? 'CAVEAT_GITHUB_TARGET_UNSUPPORTED' : undefined) ?? (user != null && /Authentication failed|Bad credentials|HTTP 401|returned error: 401/i.test(message) ? 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE' : undefined);
}
/** Git runs credential shell snippets through sh on all three supported OSes. */
export function githubGitConfig(user?: string | null): string[] {
  if (user == null) return [];
  const selected = validateGithubUser(user);
  const quote = (value: string) => "'" + value.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
  const helper = fileURLToPath(new URL('./githubCredentialHelper.js', import.meta.url));
  return ['credential.helper=', 'credential.https://github.com.helper=',
    `credential.https://github.com.helper=!${quote(process.execPath)} ${quote(helper)} ${quote(selected)}`,
    `credential.https://github.com.username=${selected}`,
    'protocol.allow=never', 'protocol.https.allow=always', 'http.extraHeader=', 'http.https://github.com/.extraHeader='];
}
export function githubGitEnvironment(user?: string | null, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (user == null) return inherited;
  validateGithubUser(user);
  // A failed named helper must not fall through to an inherited askpass helper.
  return { ...inherited, GIT_ASKPASS: '', SSH_ASKPASS: '' };
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
