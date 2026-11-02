import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reindexAndMark, readDigestMarker } from '../src/autoReindex.js';
import { openDb } from '../src/db.js';
const tracked = vi.hoisted(() => ({ closes: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock('../src/db.js', async original => {
  const actual = await original<typeof import('../src/db.js')>();
  return { ...actual, openDb: (...args: Parameters<typeof actual.openDb>) => {
    const db = actual.openDb(...args);
    const close = vi.spyOn(db, 'close'); tracked.closes.push(close); return db;
  } };
});
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); tracked.closes.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('reindexAndMark ownership', () => {
  it.each([false, true])('closes the owned DB when digest publication fails=%s', async markerFailure => {
    const home = mkdtempSync(join(tmpdir(), 'caveat-reindex-owner-')); roots.push(home);
    const paths = { entriesDir: join(home, 'own', 'entries'), communityDir: join(home, 'community'), dbPath: join(home, 'index', 'caveat.db') };
    mkdirSync(paths.entriesDir, { recursive: true });
    const row = '---\nid: known\ntitle: Known\nvisibility: private\nconfidence: confirmed\ntags: []\nenvironment: {}\nsource_project: null\nsource_session: test\ncreated_at: 2026-11-02\nupdated_at: 2026-11-02\n---\n\n## Symptom\nKnown failure\n';
    writeFileSync(join(paths.entriesDir, 'known.md'), row);
    if (markerFailure) mkdirSync(join(home, 'index', '.entries-digest'), { recursive: true });
    const result = reindexAndMark({ caveatHome: home, paths, logger: { info() {}, warn() {}, error() {} } });
    if (markerFailure) await expect(result).rejects.toThrow();
    else { await result; expect(readDigestMarker(home)?.fileCount).toBe(1); }
    expect(tracked.closes).toHaveLength(1); expect(tracked.closes[0]).toHaveBeenCalledTimes(1);
    const db = openDb({ path: paths.dbPath });
    try { expect(db.prepare('SELECT id FROM entries').get()?.id).toBe('known'); }
    finally { db.close(); }
  });
});
