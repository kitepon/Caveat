import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Logger } from '@caveat/core';
import { buildContext } from '../src/context.js';
import { runInit } from '../src/commands/init.js';
import { runIndex } from '../src/commands/indexCmd.js';

interface Fixture {
  root: string;
  caveatHome: string;
  userHome: string;
  knowledgeRepo: string;
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'caveat-cli-'));
  const caveatHome = join(root, 'caveat-home');
  const userHome = join(root, 'home');
  // Place knowledge repo at the default relative path so no user config is required
  const knowledgeRepo = join(caveatHome, 'own');

  mkdirSync(caveatHome, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(knowledgeRepo, { recursive: true });
  mkdirSync(join(knowledgeRepo, 'entries', 'gpu'), { recursive: true });

  return { root, caveatHome, userHome, knowledgeRepo };
}

function cleanup(fx: Fixture): void {
  rmSync(fx.root, { recursive: true, force: true });
}

function sampleCaveat(id: string, title: string): string {
  return `---
id: ${id}
title: ${title}
visibility: public
confidence: reproduced
outcome: resolved
tags: [gpu, cuda]
environment:
  gpu: RTX 5090
  cuda: ">=12.5"
source_project: null
source_session: "2026-04-18T12:34:56Z/abc123def456"
created_at: 2026-04-18
updated_at: 2026-04-18
last_verified: 2026-04-18
---

## Symptom
Sample symptom text.

## Cause
Sample cause.

## Resolution
Sample resolution.

## Evidence
- http://example.com
`;
}

describe('init', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('creates ~/.caveatrc.json if missing and initializes .index/caveat.db', async () => {
    const ctx = buildContext(silentLogger, { caveatHome: fx.caveatHome, userHome: fx.userHome });
    await runInit(ctx, { skipClaude: true, dryRun: false }, { env: {}, codexAvailable: () => false, isTty: () => false });

    expect(existsSync(join(fx.userHome, '.caveatrc.json'))).toBe(true);
    expect(readFileSync(join(fx.userHome, '.caveatrc.json'), 'utf-8').trim()).toBe('{}');
    expect(existsSync(join(fx.caveatHome, 'index', 'caveat.db'))).toBe(true);
  });

  it('preserves existing user config content', async () => {
    const customKnowledgeRepo = join(fx.root, 'custom-knowledge-repo');
    writeFileSync(
      join(fx.userHome, '.caveatrc.json'),
      JSON.stringify({ knowledgeRepo: customKnowledgeRepo }),
      'utf-8',
    );
    const ctx = buildContext(silentLogger, { caveatHome: fx.caveatHome, userHome: fx.userHome });
    await runInit(ctx, { skipClaude: true, dryRun: false }, { env: {}, codexAvailable: () => false, isTty: () => false });

    const after = JSON.parse(readFileSync(join(fx.userHome, '.caveatrc.json'), 'utf-8')) as {
      knowledgeRepo: string;
    };
    expect(after.knowledgeRepo).toBe(customKnowledgeRepo);
  });
});

describe('index', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('picks up md files under entries/', async () => {
    writeFileSync(
      join(fx.knowledgeRepo, 'entries', 'gpu', 'foo.md'),
      sampleCaveat('foo', 'Foo title'),
      'utf-8',
    );

    const ctx = buildContext(silentLogger, { caveatHome: fx.caveatHome, userHome: fx.userHome });
    await runInit(ctx, { skipClaude: true, dryRun: false }, { env: {}, codexAvailable: () => false, isTty: () => false });
    await runIndex(ctx, { full: false });

    // Read back via opened db
    const db = openDb({ path: ctx.paths.dbPath });
    try {
      const row = db.prepare('SELECT id, source, title FROM entries WHERE id = ?').get('foo') as
        | { id: string; source: string; title: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.source).toBe('own');
      expect(row?.title).toBe('Foo title');
    } finally {
      db.close();
    }
  });

  it('--full DELETEs existing entries before rescan', async () => {
    writeFileSync(
      join(fx.knowledgeRepo, 'entries', 'gpu', 'a.md'),
      sampleCaveat('a', 'A'),
      'utf-8',
    );

    const ctx = buildContext(silentLogger, { caveatHome: fx.caveatHome, userHome: fx.userHome });
    await runInit(ctx, { skipClaude: true, dryRun: false }, { env: {}, codexAvailable: () => false, isTty: () => false });
    await runIndex(ctx, { full: false });

    // Verify 'a' was inserted
    let db = openDb({ path: ctx.paths.dbPath });
    let count = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    db.close();
    expect(count).toBe(1);

    // Full rebuild: delete 'a' first, then rescan (which re-inserts 'a' since md still exists)
    await runIndex(ctx, { full: true });

    db = openDb({ path: ctx.paths.dbPath });
    count = (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    db.close();
    expect(count).toBe(1);
  });
});
