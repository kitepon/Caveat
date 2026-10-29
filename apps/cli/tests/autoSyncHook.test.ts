import { isolatedGitEnv } from '../../../scripts/test-git-env.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 3_000;
// No Windows 2025 p95 is retained in the repository. This is a local child
// process bound, not a CI job limit; the surrounding bounds leave enough time
// to report the failing git phase.
const GIT_PROCESS_TIMEOUT_MS = 20_000;
const GIT_FIXTURE_SETUP_TIMEOUT_MS = 45_000;
const GIT_FIXTURE_CLEANUP_TIMEOUT_MS = 30_000;
const GIT_E2E_TEST_TIMEOUT_MS = 60_000;
const AUTO_SYNC_FIXTURE_NAME = 'auto sync hook fixture';

function entry(id: string, title: string, symptom: string): string {
  return `---
id: ${id}
title: ${title}
visibility: public
confidence: confirmed
tags: [autosync, community]
environment: {}
source_project: null
source_session: test
created_at: 2026-07-12
updated_at: 2026-07-12
---

## Symptom
${symptom}
`;
}

function cli(args: string[], home: string, phase: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), ...args],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      input: JSON.stringify({ session_id: 'auto-sync', prompt: 'nebula prism sync failure' }),
      encoding: 'utf-8',
      timeout: GIT_PROCESS_TIMEOUT_MS,
      env: {
        ...env,
        CAVEAT_HOME: home,
        HOME: join(home, 'user'),
        GIT_AUTHOR_NAME: 'Caveat Test',
        GIT_AUTHOR_EMAIL: 'caveat@example.com',
        GIT_COMMITTER_NAME: 'Caveat Test',
        GIT_COMMITTER_EMAIL: 'caveat@example.com',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
    },
  );
  if (result.error) {
    throw new Error(`${AUTO_SYNC_FIXTURE_NAME}: CLI phase ${phase} failed or timed out after ${GIT_PROCESS_TIMEOUT_MS}ms: ${result.error.message}`, { cause: result.error });
  }
  return result;
}

function git(args: string[], cwd: string, phase: string) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_PROCESS_TIMEOUT_MS,
    env: {
      ...process.env, ...isolatedGitEnv(process.env.HOME!),
      GIT_AUTHOR_NAME: 'Caveat Test',
      GIT_AUTHOR_EMAIL: 'caveat@example.com',
      GIT_COMMITTER_NAME: 'Caveat Test',
      GIT_COMMITTER_EMAIL: 'caveat@example.com',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    },
  });
  if (result.error) {
    throw new Error(`${AUTO_SYNC_FIXTURE_NAME}: git phase ${phase} failed or timed out after ${GIT_PROCESS_TIMEOUT_MS}ms: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${AUTO_SYNC_FIXTURE_NAME}: git phase ${phase} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function fresh(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-auto-sync-hook-'));
  for (const [key, value] of Object.entries(isolatedGitEnv(join(home, 'user')))) vi.stubEnv(key, /^GIT_CONFIG/i.test(key) ? undefined : value);
  mkdirSync(join(home, 'own', 'entries'), { recursive: true });
  mkdirSync(join(home, 'community'), { recursive: true });
  mkdirSync(join(home, 'user'), { recursive: true });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function setupCommunityClone(home: string): { source: string; clone: string } {
  const bare = join(home, 'remote.git');
  const source = join(home, 'source');
  const clone = join(home, 'community', 'team');
  git(['init', '--bare', bare], home, 'init bare remote');
  mkdirSync(join(source, 'entries'), { recursive: true });
  git(['init', '-b', 'main'], source, 'init source repo');
  git(['remote', 'add', 'origin', bare], source, 'add source remote');
  writeFileSync(
    join(source, 'entries', 'first.md'),
    entry('first', 'Quasar junction boot failure', 'Quasar junction boot failure reports a rare anchor mismatch.'),
  );
  git(['add', '-A'], source, 'stage initial community entry');
  git(['commit', '-m', 'initial community entry'], source, 'commit initial community entry');
  git(['push', '-u', 'origin', 'main'], source, 'push initial community entry');
  git(['clone', bare, clone], home, 'clone community repo');
  return { source, clone };
}

describe('auto sync hook', { timeout: GIT_E2E_TEST_TIMEOUT_MS }, () => {
  let fixture: ReturnType<typeof fresh>;
  beforeEach(() => {
    fixture = fresh();
  }, GIT_FIXTURE_SETUP_TIMEOUT_MS);
  afterEach(() => {
    fixture.cleanup();
  }, GIT_FIXTURE_CLEANUP_TIMEOUT_MS);

  it('pulls community updates and reindexes them while own sync skips non-repos', async () => {
    const { source, clone } = setupCommunityClone(fixture.home);
    writeFileSync(
      join(source, 'entries', 'second.md'),
      entry('second', 'Nebula prism sync failure', 'Nebula prism sync failure reports a rare autosync anchor.'),
    );
    git(['add', '-A'], source, 'stage second community entry');
    git(['commit', '-m', 'add second community entry'], source, 'commit second community entry');
    git(['push', 'origin', 'main'], source, 'push second community entry');

    const result = cli(['hook', 'autosync'], fixture.home, 'run autosync hook');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    await waitFor(join(fixture.home, 'sync', '.last-autosync.json'));
    expect(existsSync(join(clone, 'entries', 'second.md'))).toBe(true);

    const prompt = cli(['hook', 'user-prompt-submit'], fixture.home, 'run prompt hook');
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain('Nebula prism sync failure');
  });

  it('honors the autosync kill switch', () => {
    setupCommunityClone(fixture.home);
    const result = cli(['hook', 'autosync'], fixture.home, 'run autosync hook with kill switch', { ...process.env, CAVEAT_AUTO_SYNC: 'off' });
    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.home, 'sync', '.last-autosync.json'))).toBe(false);
  });

  it('returns without writing state when a live autosync lock exists', () => {
    setupCommunityClone(fixture.home);
    mkdirSync(join(fixture.home, 'sync'), { recursive: true });
    writeFileSync(join(fixture.home, 'sync', '.autosync-lock'), String(process.pid), 'utf-8');
    const result = cli(['hook', 'autosync'], fixture.home, 'run autosync hook with live lock');
    expect(result.status).toBe(0);
    expect(existsSync(join(fixture.home, 'sync', '.last-autosync.json'))).toBe(false);
    expect(readFileSync(join(fixture.home, 'sync', '.autosync-lock'), 'utf-8')).toBe(String(process.pid));
  });
});

afterEach(() => { vi.unstubAllEnvs(); });
