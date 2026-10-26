import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { githubGitConfig, githubGitEnvironment } from '@caveat/core';

describe('built named GitHub helper with synthetic stores', () => {
  it.each([undefined, 'GH_TOKEN', 'GITHUB_TOKEN'])('selects the inactive user and refuses a missing user with parent %s', ambient => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-github-account-'));
    try {
      const home = join(root, 'home'), gh = join(root, 'gh'), repo = join(root, 'repo');
      for (const dir of [home, gh, repo]) mkdirSync(dir, { mode: 0o700 });
      const hosts = join(gh, 'hosts.yml');
      writeFileSync(hosts, JSON.stringify({ 'github.com': { user: 'fixture-active', oauth_token: 'fixture-active-token-never-valid',
        users: { 'fixture-active': { oauth_token: 'fixture-active-token-never-valid' }, 'fixture-target': { oauth_token: 'fixture-target-token-never-valid' } } } }), { mode: 0o600 });
      const productHelper = fileURLToPath(new URL('../dist/githubCredentialHelper.js', import.meta.url));
      const coreHelper = fileURLToPath(new URL('../../../packages/core/dist/githubCredentialHelper.js', import.meta.url));
      const wrapper = join(root, 'fixture-helper.mjs');
      // The product's protocol function runs in a real Git child. Only gh itself is a synthetic store reader.
      writeFileSync(wrapper, `import { namedGithubCredential } from ${JSON.stringify(pathToFileURL(productHelper).href)};
import { readFileSync } from 'node:fs'; import { join } from 'node:path';
if(process.argv[3]==='get')try{process.stdout.write(namedGithubCredential(readFileSync(0,'utf8'),process.argv[2],process.env,(args,env)=>{
 if(!args.includes('--no-refresh')||['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'].some(k=>env[k]))throw Error('fixture_child_scope_broken');
 const users=JSON.parse(readFileSync(join(env.GH_CONFIG_DIR,'hosts.yml'),'utf8'))['github.com'].users;
 const credential=users[args[args.indexOf('--user')+1]]?.oauth_token;
 return {status:credential?0:1,stdout:credential??'',stderr:credential?'':'no oauth token found',error:undefined};
}));}catch(error){process.stderr.write((error.code??'fixture_helper_failed')+'\\n');process.exitCode=2;}`, { mode: 0o600 });
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
      if (ambient === undefined) {
        const installed = spawnSync('gh', ['--version'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
        console.log('[caveat:github-fixture-runtime] ' + JSON.stringify({ ghVersion: installed.status === 0 ? installed.stdout.split(/\r?\n/)[0] : 'unavailable', credentialBackend: 'synthetic', authOperations: 0 }));
      }
      const request = 'protocol=https\nhost=github.com\npath=fixture-owner/fixture-repository.git\n\n';
      const fill = (user: string) => git([...githubGitConfig(user).map(value => value.replace(coreHelper.replace(/\\/g, '/'), wrapper.replace(/\\/g, '/'))).flatMap(value => ['-c', value]), 'credential', 'fill'], request, user);
      const found = fill('fixture-target');
      expect(found.error).toBeUndefined(); expect(found.status, found.stderr).toBe(0);
      expect(found.stdout).toBe('protocol=https\nhost=github.com\nusername=fixture-target\npassword=fixture-target-token-never-valid\n');
      const absent = fill('fixture-missing');
      expect(absent.status).not.toBe(0); expect(absent.stdout).not.toContain('password='); expect(absent.stderr).toContain('CAVEAT_GITHUB_USER_UNAVAILABLE');
      expect(readFileSync(hosts, 'utf8')).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
});
