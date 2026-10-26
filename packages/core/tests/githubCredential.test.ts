import { describe, expect, it, vi } from 'vitest';
import { namedGithubCredential } from '../src/githubCredentialHelper.js';
import { githubGitConfig, githubGitEnvironment, githubCredentialFailureCode, assertNamedGithubTargets } from '../src/githubCredential.js';
import { SyncError } from '../src/sync.js';
const input = 'protocol=https\nhost=github.com\nusername=kitepon-rgb\n\n';
const success = { status: 0, stdout: 'fixture-target-token\n', stderr: '', error: undefined };

describe('named GitHub credential', () => {
  it('keeps unconfigured Git configuration and environment unchanged', () => {
    const inherited = { GH_TOKEN: 'fixture-parent', GIT_ASKPASS: 'existing-helper' };
    expect(githubGitConfig()).toEqual([]); expect(githubGitConfig(null)).toEqual([]);
    expect(githubGitEnvironment(undefined, inherited)).toBe(inherited);
  });
  it('limits the named account to explicit HTTPS GitHub remotes', () => {
    expect(() => assertNamedGithubTargets(['https://github.com/kitepon-rgb/Caveat-Private.git'], 'kitepon-rgb')).not.toThrow();
    for (const remote of ['git@github.com:owner/repo.git', 'https://elsewhere.invalid/repo', 'https://fixture-token@github.com/repo'])
      expect(() => assertNamedGithubTargets([remote], 'kitepon-rgb')).toThrow('CAVEAT_GITHUB_TARGET_UNSUPPORTED');
    expect(() => assertNamedGithubTargets(['file:///legacy-repo'])).not.toThrow();
  });
  it('preserves typed named-account failures without changing legacy remote classification', () => {
    expect(githubCredentialFailureCode(new Error('Authentication failed'), 'kitepon-rgb')).toBe('CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE');
    expect(githubCredentialFailureCode(new Error('Authentication failed'))).toBeUndefined();
  });
  it.each(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])('ignores parent %s and names the inactive user without refreshing', key => {
    const env = { [key]: 'fixture-parent', GH_CONFIG_DIR: 'fixture-store', KEEP: 'same' };
    const run = vi.fn((args, child) => { expect(args).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'kitepon-rgb', '--no-refresh']); expect(child).toEqual({ GH_CONFIG_DIR: 'fixture-store', KEEP: 'same' }); return success; });
    expect(namedGithubCredential(input, 'kitepon-rgb', env, run)).toBe('username=kitepon-rgb\npassword=fixture-target-token\n\n');
    expect(env[key]).toBe('fixture-parent'); expect(run).toHaveBeenCalledOnce();
  });
  it('resets generic and URL-specific shared helpers and closes askpass fallback only in the child', () => {
    const settings = githubGitConfig('kitepon-rgb');
    expect(settings.slice(0, 2)).toEqual(['credential.helper=', 'credential.https://github.com.helper=']);
    expect(settings[2]).toContain('githubCredentialHelper.js'); expect(settings[2]).toContain("'kitepon-rgb'");
    const original = { GIT_ASKPASS: 'shared-active-helper', SSH_ASKPASS: 'shared-ssh-helper' };
    expect(githubGitEnvironment('kitepon-rgb', original)).toEqual({ GIT_ASKPASS: '', SSH_ASKPASS: '' });
    expect(original.GIT_ASKPASS).toBe('shared-active-helper');
  });
  it.each(['', 'bad\nuser', '-bad', 'bad;', 'a'.repeat(40)])('rejects malformed account %j before invoking gh', user => {
    const run = vi.fn(() => success); expect(() => namedGithubCredential(input, user, {}, run)).toThrow('CAVEAT_GITHUB_USER_INVALID'); expect(run).not.toHaveBeenCalled();
  });
  it.each([
    [input.replace('kitepon-rgb', 'quolu'), 'CAVEAT_GITHUB_USERNAME_MISMATCH'],
    [input.replace('github.com', 'elsewhere.invalid'), 'CAVEAT_GITHUB_TARGET_UNSUPPORTED'],
    [input.replace('https', 'http'), 'CAVEAT_GITHUB_TARGET_UNSUPPORTED'],
  ])('rejects a mismatched Git request without reading a credential', (request, code) => {
    const run = vi.fn(() => success); expect(() => namedGithubCredential(request, 'kitepon-rgb', {}, run)).toThrow(code); expect(run).not.toHaveBeenCalled();
  });
  it.each([
    [{ ...success, status: 1, stdout: '', stderr: 'no oauth token found for account' }, 'CAVEAT_GITHUB_USER_UNAVAILABLE'],
    [{ ...success, error: Object.assign(new Error('fixture missing'), { code: 'ENOENT' }) }, 'CAVEAT_GITHUB_CLI_UNAVAILABLE'],
    [{ ...success, status: 1, stderr: 'unknown flag: --user' }, 'CAVEAT_GITHUB_CLI_UNSUPPORTED'],
    [{ ...success, status: 1, stderr: 'unknown flag: --no-refresh' }, 'CAVEAT_GITHUB_CLI_UNSUPPORTED'],
    [{ ...success, stderr: 'This token will expire on 2000-01-01T00:00:00Z, or may be revoked.' }, 'CAVEAT_GITHUB_CREDENTIAL_EXPIRED'],
    [{ ...success, stderr: 'This token will expire on invalid-date, or may be revoked.' }, 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE'],
    [{ ...success, status: 1, stderr: 'the token has expired' }, 'CAVEAT_GITHUB_CREDENTIAL_EXPIRED'],
    [{ ...success, stdout: 'bad\ncredential\n' }, 'CAVEAT_GITHUB_CREDENTIAL_UNAVAILABLE'],
  ])('refuses missing, unsupported, expired or malformed credentials without fallback', (result, code) => {
    const run = vi.fn(() => result); let failure: unknown;
    try { namedGithubCredential(input, 'kitepon-rgb', { GH_TOKEN: 'fixture-active' }, run); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SyncError); expect(githubCredentialFailureCode(failure)).toBe(code); expect((failure as Error).message).toBe(code); expect(run).toHaveBeenCalledOnce();
  });
});
