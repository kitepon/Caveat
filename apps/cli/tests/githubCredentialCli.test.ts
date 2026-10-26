import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubGitConfig, githubGitEnvironment } from '@caveat/core';

describe('built named GitHub helper with synthetic stores', () => {
  it.each([undefined, 'GH_TOKEN', 'GITHUB_TOKEN'])('selects the inactive user and refuses a missing user with parent %s', ambient => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-github-account-'));
    try {
      const home = join(root, 'home'), gh = join(root, 'gh'), repo = join(root, 'repo');
      for (const dir of [home, gh, repo]) mkdirSync(dir, { mode: 0o700 });
      const hosts = join(gh, 'hosts.yml');
      writeFileSync(hosts, 'github.com:\n    user: fixture-active\n    oauth_token: fixture-active-token-never-valid\n    git_protocol: https\n    users:\n        fixture-active:\n            oauth_token: fixture-active-token-never-valid\n        fixture-target:\n            oauth_token: fixture-target-token-never-valid\n', { mode: 0o600 });
      const before = readFileSync(hosts, 'utf8');
      const inherited = { ...process.env };
      for (const key of Object.keys(inherited)) if (['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG', 'DBUS_SESSION_BUS_ADDRESS'].includes(key) || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete inherited[key];
      const env = { ...inherited, HOME: home, USERPROFILE: home, GH_CONFIG_DIR: gh, XDG_CONFIG_HOME: join(root, 'xdg'),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0',
        GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
        ...(ambient ? { [ambient]: 'fixture-environment-token-never-valid' } : {}) };
      const git = (args: string[], input?: string, selected?: string) => spawnSync('git', ['-C', repo, ...args], {
        env: githubGitEnvironment(selected, env), input, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      });
      expect(git(['init', '-q']).status).toBe(0);
      for (const key of ['credential.helper', 'credential.https://github.com.helper']) expect(git(['config', key, '!gh auth git-credential']).status).toBe(0);
      const request = 'protocol=https\nhost=github.com\npath=fixture-owner/fixture-repository.git\n\n';
      const fill = (user: string) => git([...githubGitConfig(user).flatMap(value => ['-c', value]), 'credential', 'fill'], request, user);
      const found = fill('fixture-target');
      expect(found.error).toBeUndefined(); expect(found.status).toBe(0);
      expect(found.stdout).toBe('protocol=https\nhost=github.com\nusername=fixture-target\npassword=fixture-target-token-never-valid\n');
      const absent = fill('fixture-missing');
      expect(absent.status).not.toBe(0); expect(absent.stdout).not.toContain('password='); expect(absent.stderr).toContain('CAVEAT_GITHUB_USER_UNAVAILABLE');
      expect(readFileSync(hosts, 'utf8')).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});
