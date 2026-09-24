import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  jevObservationId,
  openDb,
  recordEntry,
  loadConfig,
  resolvePaths,
  type Logger,
  writeJevObservation,
  reviewJevObservation,
} from '@caveat/core';
import type { WebContext } from '../src/context.js';
import { createApp } from '../src/app.js';

interface Fx {
  root: string;
  caveatHome: string;
  userHome: string;
  ctx: WebContext;
  db: DatabaseSync;
  app: ReturnType<typeof createApp>;
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-web-'));
  const caveatHome = join(root, 'caveat-home');
  const userHome = join(root, 'home');
  const knowledgeRepo = join(caveatHome, 'own');

  mkdirSync(caveatHome, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(join(knowledgeRepo, 'entries'), { recursive: true });

  const config = loadConfig(join(userHome, '.caveatrc.json'));
  const paths = resolvePaths(caveatHome, config.knowledgeRepo, userHome);
  const db = openDb({ path: paths.dbPath, logger: silentLogger });

  const ctx: WebContext = {
    caveatHome,
    userHome,
    userConfigPath: join(userHome, '.caveatrc.json'),
    config,
    paths,
    logger: silentLogger,
    db,
  };
  const app = createApp(ctx);
  return { root, caveatHome, userHome, ctx, db, app };
}

function cleanup(f: Fx): void {
  f.db.close();
  rmSync(f.root, { recursive: true, force: true });
}

describe('web routes', () => {
  let f: Fx;
  beforeEach(() => {
    f = makeFx();
  });
  afterEach(() => {
    cleanup(f);
  });

  describe('GET /', () => {
    it('returns empty state when no entries', async () => {
      const res = await f.app.request('/');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('no entries yet');
      expect(html).toContain('<title>Caveat</title>');
    });

    it('lists recent entries when present', async () => {
      recordEntry(
        { title: 'Sample gotcha', symptom: 'Something broken', tags: ['gpu'] },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/');
      const html = await res.text();
      expect(html).toContain('Sample gotcha');
      expect(html).toContain('/g/sample-gotcha');
    });

    it('FTS search filters results', async () => {
      recordEntry(
        { title: 'RTX 5090 issue', symptom: 'gpu fail' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      recordEntry(
        { title: 'unrelated topic', symptom: 'nothing' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/?q=rtx');
      const html = await res.text();
      expect(html).toContain('RTX 5090 issue');
      expect(html).not.toContain('unrelated topic');
    });
  });

  describe('GET /jev', () => {
    it('集計の分母と案件の判定材料を表示する', async () => {
      const id = jevObservationId('claude', 'session-1', 'session-1:3');
      writeJevObservation(f.caveatHome, {
        schema: 'caveat.jev_observation.v1', id, observedAt: '2026-09-24T00:00:00.000Z',
        host: 'claude', sessionId: 'session-1', projectRoot: '/work', transcriptPath: '/work/transcript.jsonl',
        turns: [1, 2, 3].map((turnNumber) => ({ originSessionId: 'session-1', turnNumber, truncated: false })),
        thinkingAvailable: true, model: 'jev-1.13.0', repeatedProblem: 0.95, clearlyStuck: 0.91,
        struggleThreshold: 0.85, struggling: true, termChoices: [{ term: 'workerd', probability: 0.6 }],
        noneProbability: 0.1, selectedTerms: ['workerd'], query: 'workerd', ftsHits: ['own/known'],
        candidates: [{ ref: 'own/known', score: 0.89 }], matchThreshold: 0.8, selectedRef: 'own/known',
        noticeText: '[caveat] 関連知見: own/known 対処: 接続を修正',
        decision: 'matched', delivery: 'delivered', review: null,
      });
      reviewJevObservation(f.caveatHome, id, 'correct', '症状一致');
      const res = await f.app.request('/jev');
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('100%');
      expect(html).toContain('1/1 件を評価');
      expect(html).toContain('own/known 0.89');
      expect(html).toContain('session-1 #3');
      expect(html).toContain('/work/transcript.jsonl');
      expect(html).toContain('症状一致');
    });
  });

  describe('GET /g/:id', () => {
    it('returns 404 for missing id', async () => {
      const res = await f.app.request('/g/nonexistent');
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('not found');
    });

    it('renders full caveat with frontmatter + body', async () => {
      recordEntry(
        {
          title: 'detail case',
          symptom: 'body of the symptom',
          cause: 'cause text',
          confidence: 'confirmed',
          tags: ['gpu'],
        },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/g/detail-case');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('detail case');
      expect(html).toContain('body of the symptom');
      expect(html).toContain('cause text');
      expect(html).toContain('confirmed');
    });

    it('renders wikilinks in body', async () => {
      recordEntry(
        {
          title: 'referencing case',
          symptom: 'see [[other-case]] for context',
        },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/g/referencing-case');
      const html = await res.text();
      expect(html).toContain('href="/g/other-case"');
      expect(html).toContain('class="wikilink"');
    });
  });

  describe('visibility filter and badge', () => {
    it('shows public and private badges for entries on the list', async () => {
      recordEntry(
        { title: 'public one', symptom: 'p', visibility: 'public' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      recordEntry(
        { title: 'private one', symptom: 'q', visibility: 'private' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/');
      const html = await res.text();
      expect(html).toContain('badge public');
      expect(html).toContain('badge private');
      expect(html).toContain('private one');
      expect(html).toContain('public one');
    });

    it('?visibility=public hides private entries', async () => {
      recordEntry(
        { title: 'public one', symptom: 'p', visibility: 'public' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      recordEntry(
        { title: 'private one', symptom: 'q', visibility: 'private' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/?visibility=public');
      const html = await res.text();
      expect(html).toContain('public one');
      expect(html).not.toContain('private one');
    });

    it('?visibility=private hides public entries', async () => {
      recordEntry(
        { title: 'public one', symptom: 'p', visibility: 'public' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      recordEntry(
        { title: 'private one', symptom: 'q', visibility: 'private' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/?visibility=private');
      const html = await res.text();
      expect(html).toContain('private one');
      expect(html).not.toContain('public one');
    });

    it('detail page renders visibility badge instead of plain text', async () => {
      recordEntry(
        { title: 'private detail', symptom: 's', visibility: 'private' },
        { db: f.db, entriesRoot: f.ctx.paths.entriesDir },
      );
      const res = await f.app.request('/g/private-detail');
      const html = await res.text();
      expect(html).toContain('badge private');
    });
  });

  describe('GET /community', () => {
    it('shows empty state when no community repos', async () => {
      const res = await f.app.request('/community');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('no community repos imported');
    });

    it('lists imported community handles', async () => {
      mkdirSync(join(f.ctx.paths.communityDir, 'alice'), { recursive: true });
      mkdirSync(join(f.ctx.paths.communityDir, 'bob'), { recursive: true });
      const res = await f.app.request('/community');
      const html = await res.text();
      expect(html).toContain('alice');
      expect(html).toContain('bob');
    });
  });
});
