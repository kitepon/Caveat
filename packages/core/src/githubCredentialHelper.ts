import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateGithubUser, githubCredentialFailureCode } from './githubCredential.js';
import { SyncError } from './syncErrors.js';

type GhRunner = (args: string[], env: NodeJS.ProcessEnv) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;
const ghExecutable = process.platform === 'darwin' ? '/opt/homebrew/bin/gh' : process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : '/usr/bin/gh';
const runGh: GhRunner = (args, env) => spawnSync(ghExecutable, args,
  { env, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536, windowsHide: true });

/** Only Git's credential pipe receives the selected value; never persist/log it. */
export function namedGithubCredential(input: string, requestedUser: unknown, inherited: NodeJS.ProcessEnv = process.env, run: GhRunner = runGh): string {
  const user = validateGithubUser(requestedUser);
  if (Buffer.byteLength(input) > 8192) throw new SyncError('CAVEAT_GITHUB_TARGET_UNSUPPORTED', 'CAVEAT_GITHUB_TARGET_UNSUPPORTED');
  const fields = new Map(input.split(/\r?\n/).filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com') throw new SyncError('CAVEAT_GITHUB_TARGET_UNSUPPORTED', 'CAVEAT_GITHUB_TARGET_UNSUPPORTED');
  if (fields.has('username') && fields.get('username') !== user) throw new SyncError('CAVEAT_GITHUB_USERNAME_MISMATCH', 'CAVEAT_GITHUB_USERNAME_MISMATCH');
  const env = { ...inherited };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG']) delete env[key];
  const result = run(['auth', 'token', '--hostname', 'github.com', '--user', user, '--no-refresh'], env);
  if (result.error) throw new SyncError('CAVEAT_GITHUB_CLI_UNAVAILABLE', 'CAVEAT_GITHUB_CLI_UNAVAILABLE');
  if (/unknown flag.*--(?:user|no-refresh)|unknown command/i.test(result.stderr)) throw new SyncError('CAVEAT_GITHUB_CLI_UNSUPPORTED', 'CAVEAT_GITHUB_CLI_UNSUPPORTED');
  const expiry = /This token will expire on ([^,\s]+)/.exec(result.stderr)?.[1];
  if (/will expire/i.test(result.stderr) && (!expiry || !Number.isFinite(Date.parse(expiry)))) throw new SyncError('CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE', 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE');
  if ((expiry && Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) <= Date.now()) || (result.status !== 0 && /expired/i.test(result.stderr))) throw new SyncError('CAVEAT_GITHUB_CREDENTIAL_EXPIRED', 'CAVEAT_GITHUB_CREDENTIAL_EXPIRED');
  if (result.status !== 0) throw new SyncError('CAVEAT_GITHUB_USER_UNAVAILABLE', 'CAVEAT_GITHUB_USER_UNAVAILABLE');
  const token = result.stdout.trim();
  if (!token || /\s/.test(token)) throw new SyncError('CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE', 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE');
  return `username=${user}\npassword=${token}\n\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[3] === 'get') {
    try { process.stdout.write(namedGithubCredential(readFileSync(0, 'utf8'), process.argv[2])); }
    catch (error) { process.stderr.write(`${githubCredentialFailureCode(error) ?? 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE'}\n`); process.exitCode = 2; }
  }
}
