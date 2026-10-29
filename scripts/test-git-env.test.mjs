import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { isolatedGitEnv } from './test-git-env.mjs';
test('Git fixture globals and writes stay inside the temporary home', () => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-git-env-')), runner = join(root, 'runner.gitconfig');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    process.env.GIT_CONFIG_GLOBAL = runner;
    writeFileSync(runner, '[user]\n name = runner-private\n');
    const env = { ...process.env, ...isolatedGitEnv(join(root, 'home')) };
    assert.equal(env.HOME, env.USERPROFILE); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    const call = (...args) => spawnSync('git', ['config', '--global', ...args], { env, encoding: 'utf8' });
    assert.equal(call('--get', 'user.name').status, 1);
    assert.equal(call('user.name', 'fixture-only').status, 0);
    assert.equal(call('--get', 'user.name').stdout.trim(), 'fixture-only');
    assert.equal(readFileSync(runner, 'utf8'), '[user]\n name = runner-private\n');
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; rmSync(root, { recursive: true, force: true }); }
});
