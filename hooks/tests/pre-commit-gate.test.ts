import { isolatedGitEnv } from '../../scripts/test-git-env.mjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findBlockedFiles } from '@caveat/core';

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'pre-commit-visibility-gate.mjs',
);

function sampleMd(visibility: string): string {
  return `---
id: sample
title: sample
visibility: ${visibility}
confidence: tentative
outcome: resolved
tags: []
environment: {}
source_project: null
source_session: "2026-04-18T00:00:00.000Z/abcdef012345"
created_at: 2026-04-18
updated_at: 2026-04-18
---

## Symptom
text
`;
}

describe('findBlockedFiles (unit)', () => {
  it('blocks entries with visibility: private', () => {
    const result = findBlockedFiles([
      { path: 'entries/gpu/a.md', content: sampleMd('private') },
      { path: 'entries/gpu/b.md', content: sampleMd('public') },
    ]);
    expect(result).toEqual(['entries/gpu/a.md']);
  });

  it('allows visibility: public', () => {
    const result = findBlockedFiles([
      { path: 'entries/a.md', content: sampleMd('public') },
    ]);
    expect(result).toEqual([]);
  });

  it('does not block when frontmatter lacks visibility field', () => {
    const noVis = `---
id: x
title: x
confidence: tentative
---

## Symptom
s
`;
    const result = findBlockedFiles([{ path: 'entries/x.md', content: noVis }]);
    expect(result).toEqual([]);
  });

  it('does not block unparseable frontmatter (lets caveat index catch it)', () => {
    const garbage = `not even close to markdown with frontmatter`;
    const result = findBlockedFiles([{ path: 'entries/x.md', content: garbage }]);
    expect(result).toEqual([]);
  });
});

interface GitFx {
  root: string;
}

function gitFx(): GitFx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-precommit-'));
  for (const [key, value] of Object.entries(isolatedGitEnv(join(root, 'git-home')))) vi.stubEnv(key, /^GIT_CONFIG/i.test(key) ? undefined : value);
  execFileSync('git', ['init', '-q'], { env: { ...process.env, ...isolatedGitEnv(process.env.HOME!) }, cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { env: { ...process.env, ...isolatedGitEnv(process.env.HOME!) }, cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { env: { ...process.env, ...isolatedGitEnv(process.env.HOME!) }, cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { env: { ...process.env, ...isolatedGitEnv(process.env.HOME!) }, cwd: root });
  mkdirSync(join(root, 'entries'), { recursive: true });
  return { root };
}

function stageFile(cwd: string, relPath: string, content: string): void {
  const full = join(cwd, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  execFileSync('git', ['add', '--', relPath], { env: { ...process.env, ...isolatedGitEnv(process.env.HOME!) }, cwd });
}

function runGate(cwd: string): { status: number; stderr: string } {
  const result = spawnSync('node', [GATE], { cwd, encoding: 'utf-8', timeout: 10000 });
  return { status: result.status ?? -1, stderr: result.stderr ?? '' };
}

describe('pre-commit-visibility-gate.mjs (integration)', () => {
  let fx: GitFx;
  beforeEach(() => {
    fx = gitFx();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('exits 0 when no staged entries', () => {
    const { status } = runGate(fx.root);
    expect(status).toBe(0);
  });

  it('exits 0 when staged entries are all public', () => {
    stageFile(fx.root, 'entries/gpu/a.md', sampleMd('public'));
    const { status } = runGate(fx.root);
    expect(status).toBe(0);
  });

  it('exits 1 and lists blocked paths when a private entry is staged', () => {
    stageFile(fx.root, 'entries/gpu/secret.md', sampleMd('private'));
    stageFile(fx.root, 'entries/gpu/ok.md', sampleMd('public'));
    const { status, stderr } = runGate(fx.root);
    expect(status).toBe(1);
    expect(stderr).toContain('entries/gpu/secret.md');
    expect(stderr).not.toContain('entries/gpu/ok.md');
    expect(stderr).toContain('commit blocked');
  });

  it('exits 0 outside a git repo (no false blocks on random dirs)', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'caveat-nongit-'));
    try {
      const { status } = runGate(nonGit);
      expect(status).toBe(0);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('ignores staged non-md files and md files outside entries/', () => {
    writeFileSync(join(fx.root, 'README.md'), sampleMd('private'), 'utf-8');
    execFileSync('git', ['add', '--', 'README.md'], { env: { ...process.env, ...isolatedGitEnv(process.env.HOME!) }, cwd: fx.root });
    const { status } = runGate(fx.root);
    expect(status).toBe(0);
  });
});

afterEach(() => { vi.unstubAllEnvs(); });
