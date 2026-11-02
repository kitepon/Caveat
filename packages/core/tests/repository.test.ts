import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertEntry } from '../src/indexer.js';
import { search, get, listRecent } from '../src/repository.js';
import { findCaveatsForPrompt } from '../src/claudeHooks.js';

const insert = (db: ReturnType<typeof openDb>, id: string, source: 'own' | `community/${string}` = 'own', overrides: Partial<{ title: string; body: string; tags: string[]; confidence: string; updated_at: string; visibility: string }> = {}) => {
  const fm = {
    id, title: overrides.title ?? `Title ${id}`, visibility: overrides.visibility ?? 'public',
    confidence: overrides.confidence ?? 'reproduced',
    tags: overrides.tags ?? ['gpu'],
    environment: { os: 'windows-11' },
    source_project: 'p', source_session: '2026-04-18T00:00:00Z/deadbeef1234',
    created_at: '2026-04-18', updated_at: overrides.updated_at ?? '2026-04-18',
  };
  upsertEntry(db, {
    id, source, path: `${id}.md`,
    title: fm.title, body: overrides.body ?? `## Symptom\nsym-${id}\n\n## Cause\ncau-${id}`,
    frontmatter_json: JSON.stringify(fm),
    tags: JSON.stringify(fm.tags),
    confidence: fm.confidence, visibility: fm.visibility,
    file_mtime: '2026-04-18', indexed_at: '2026-04-18',
  });
};

describe('search', () => {
  it('returns all when no query or filters', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a');
    insert(db, 'b');
    expect(search(db).length).toBe(2);
  });

  it('FTS matches title text', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { title: 'RTX 5090 CUDA init failure' });
    insert(db, 'b', 'own', { title: 'VSCode terminal width' });
    const r = search(db, { query: 'RTX' });
    expect(r.length).toBe(1);
    expect(r[0]!.id).toBe('a');
  });

  it('filters by source own vs community', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own');
    insert(db, 'b', 'community/alice');
    expect(search(db, { filters: { source: 'own' } }).map((r) => r.id)).toEqual(['a']);
    expect(search(db, { filters: { source: 'community' } }).map((r) => r.id)).toEqual(['b']);
    expect(search(db, { filters: { source: 'all' } }).length).toBe(2);
  });

  it('filters by confidence', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { confidence: 'tentative' });
    insert(db, 'b', 'own', { confidence: 'reproduced' });
    const r = search(db, { filters: { confidence: ['tentative'] } });
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  it('filters by tags (AND semantics)', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { tags: ['gpu', 'cuda'] });
    insert(db, 'b', 'own', { tags: ['gpu'] });
    const r = search(db, { filters: { tags: ['gpu', 'cuda'] } });
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  it('symptomExcerpt extracted from Symptom section', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { body: '## Symptom\nthe problem\n\n## Cause\nthe reason' });
    const r = search(db);
    expect(r[0]!.symptomExcerpt).toBe('the problem');
  });

  it('filters by visibility=public excludes private entries', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'pub', 'own', { visibility: 'public' });
    insert(db, 'priv', 'own', { visibility: 'private' });
    const r = search(db, { filters: { visibility: 'public' } });
    expect(r.map((x) => x.id)).toEqual(['pub']);
  });

  it('filters by visibility=private excludes public entries', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'pub', 'own', { visibility: 'public' });
    insert(db, 'priv', 'own', { visibility: 'private' });
    const r = search(db, { filters: { visibility: 'private' } });
    expect(r.map((x) => x.id)).toEqual(['priv']);
  });

  it('visibility=all (or omitted) returns both', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'pub', 'own', { visibility: 'public' });
    insert(db, 'priv', 'own', { visibility: 'private' });
    expect(search(db, { filters: { visibility: 'all' } }).length).toBe(2);
    expect(search(db).length).toBe(2);
  });

  it('result includes visibility field', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'priv', 'own', { visibility: 'private' });
    const r = search(db);
    expect(r[0]!.visibility).toBe('private');
  });

  it('orders by updated_at DESC when no FTS query', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { updated_at: '2026-04-10' });
    insert(db, 'b', 'own', { updated_at: '2026-04-18' });
    insert(db, 'c', 'own', { updated_at: '2026-04-15' });
    const r = search(db);
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('visibility filter combines with source filter', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'op', 'own', { visibility: 'public' });
    insert(db, 'opv', 'own', { visibility: 'private' });
    insert(db, 'cp', 'community/alice', { visibility: 'public' });
    const r = search(db, { filters: { source: 'own', visibility: 'public' } });
    expect(r.map((x) => x.id)).toEqual(['op']);
  });
});

describe('get', () => {
  it('returns null for missing id', () => {
    const db = openDb({ path: ':memory:' });
    expect(get(db, 'missing')).toBeNull();
  });

  it('returns parsed entry with sections map', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { body: '## Symptom\nsym\n\n## Resolution\nfix' });
    const r = get(db, 'a');
    expect(r).not.toBeNull();
    expect(r!.sections.Symptom).toBe('sym');
    expect(r!.sections.Resolution).toBe('fix');
  });
});

describe('listRecent', () => {
  it('orders by updated_at DESC', () => {
    const db = openDb({ path: ':memory:' });
    insert(db, 'a', 'own', { updated_at: '2026-04-10' });
    insert(db, 'b', 'own', { updated_at: '2026-04-18' });
    insert(db, 'c', 'own', { updated_at: '2026-04-15' });
    const r = listRecent(db);
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});


describe('shared search result contract', () => {
  it('keeps hook and repository fields identical for a long symptom', () => {
    const db = openDb({ path: ':memory:' });
    try {
      const symptom = 'Quasar junction ' + 'failure '.repeat(40);
      insert(db, 'shared', 'own', { title: 'Quasar junction boot', body: `## Symptom\n${symptom}\n\n## Cause\nseparate cause`, visibility: 'private' });
      const result = search(db, { query: 'Quasar junction' });
      expect(findCaveatsForPrompt(db, 'Quasar junction')).toEqual(result);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'shared', visibility: 'private', environment: { os: 'windows-11' } });
      expect(result[0]!.symptomExcerpt).toHaveLength(200);
      expect(result[0]!.symptomExcerpt).not.toContain('separate cause');
    } finally { db.close(); }
  });
});
