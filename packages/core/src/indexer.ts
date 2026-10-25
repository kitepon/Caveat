import { createHash } from 'node:crypto';
import { ENTRY_LIMITS, EntryInputConstraintError } from './entryConstraints.js';
import { fileSha256, constraintDiagnostic, type EntryReadDiagnostic } from './entryRead.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { deriveRoleTexts, parseMarkdown } from './frontmatter.js';
import type { Source } from './types.js';

export interface ScanSourceOptions {
  db: DatabaseSync;
  source: Source;
  entriesRoot: string;
  now?: () => string;
  force?: boolean;
}

export interface ScanResult {
  added: number;
  updated: number;
  deleted: number;
  diagnostics?: EntryReadDiagnostic[];
}

export interface EntryDocument {
  source: Source;
  path: string;
  content: string;
  file_mtime: string;
  indexed_at: string;
}

export function scanSource(opts: ScanSourceOptions): ScanResult {
  const { db, source, entriesRoot } = opts;
  const now = opts.now ?? (() => new Date().toISOString());

  db.exec('DROP TABLE IF EXISTS temp.touched');
  db.exec('CREATE TEMP TABLE touched(rowid INTEGER PRIMARY KEY)');
  const insertTouched = db.prepare('INSERT INTO touched (rowid) VALUES (?)');

  const diagnostics: EntryReadDiagnostic[] = [];
  let added = 0;
  let updated = 0;

  try {
    if (existsSync(entriesRoot)) {
      for (const filePath of walkMarkdown(entriesRoot)) {
        const stat = statSync(filePath);
        const mtime = stat.mtime.toISOString();
        const rel = relative(entriesRoot, filePath).replace(/\\/g, '/');
        const skip = (error: EntryInputConstraintError, hash: string) => {
          diagnostics.push(constraintDiagnostic(db, source, rel, hash, error, now()));
          for (const old of db.prepare('SELECT rowid FROM entries WHERE source = ? AND path = ?').all(source, rel) as Array<{rowid:number}>) insertTouched.run(old.rowid);
        };
        if (stat.size > ENTRY_LIMITS.markdown) {
          skip(new EntryInputConstraintError('entry_markdown', ENTRY_LIMITS.markdown, stat.size), fileSha256(filePath));
          continue;
        }
        const src = readFileSync(filePath, 'utf-8');
        let row: UpsertRow;
        try { row = buildEntryUpsertRow({
          source,
          path: rel,
          content: src,
          file_mtime: mtime,
          indexed_at: now(),
        }); } catch (error) {
          if (!(error instanceof EntryInputConstraintError)) throw error;
          skip(error, createHash('sha256').update(src).digest('hex'));
          continue;
        }

        const existing = db
          .prepare('SELECT rowid, file_mtime, path FROM entries WHERE source = ? AND id = ?')
          .get(source, row.id) as { rowid: number; file_mtime: string; path: string } | undefined;

        if (!opts.force && existing && existing.file_mtime === mtime && existing.path === rel) {
          insertTouched.run(existing.rowid);
          continue;
        }

        const rowid = upsertEntry(db, row);
        insertTouched.run(rowid);

        if (existing) updated++;
        else added++;
      }
    }

    const del = db
      .prepare('DELETE FROM entries WHERE source = ? AND rowid NOT IN (SELECT rowid FROM touched)')
      .run(source);
    const deleted = Number(del.changes);

    return { added, updated, deleted, ...(diagnostics.length ? { diagnostics } : {}) };
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.touched');
  }
}

export function buildEntryUpsertRow(doc: EntryDocument): UpsertRow {
  const parsed = parseMarkdown(doc.content);
  const fm = parsed.frontmatter;
  return {
    id: fm.id,
    source: doc.source,
    path: doc.path,
    title: fm.title,
    body: parsed.body,
    frontmatter_json: JSON.stringify(fm),
    tags: JSON.stringify(fm.tags ?? []),
    confidence: fm.confidence,
    visibility: fm.visibility,
    file_mtime: doc.file_mtime,
    indexed_at: doc.indexed_at,
  };
}

export interface UpsertRow {
  id: string;
  source: Source;
  path: string;
  title: string;
  body: string;
  frontmatter_json: string;
  tags: string;
  confidence: string;
  visibility: string;
  file_mtime: string;
  indexed_at: string;
}

export function upsertEntry(db: DatabaseSync, row: UpsertRow): number {
  const existing = db
    .prepare('SELECT rowid FROM entries WHERE source = ? AND id = ?')
    .get(row.source, row.id) as { rowid: number } | undefined;

  const { topical, symptom } = deriveRoleTexts({
    title: row.title,
    body: row.body,
    tags: row.tags,
    frontmatter_json: row.frontmatter_json,
  });

  if (existing) {
    db.prepare(
      `UPDATE entries
       SET path = ?, title = ?, body = ?, frontmatter_json = ?, tags = ?,
           confidence = ?, visibility = ?, file_mtime = ?, indexed_at = ?,
           topical_text = ?, symptom_text = ?
       WHERE source = ? AND id = ?`,
    ).run(
      row.path, row.title, row.body, row.frontmatter_json, row.tags,
      row.confidence, row.visibility, row.file_mtime, row.indexed_at,
      topical, symptom,
      row.source, row.id,
    );
    return existing.rowid;
  }

  const info = db.prepare(
    `INSERT INTO entries (id, source, path, title, body, frontmatter_json, tags, confidence, visibility, file_mtime, indexed_at, topical_text, symptom_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.source, row.path, row.title, row.body, row.frontmatter_json,
    row.tags, row.confidence, row.visibility, row.file_mtime, row.indexed_at,
    topical, symptom,
  );
  return Number(info.lastInsertRowid);
}

export function rebuildAll(db: DatabaseSync): void {
  db.exec('DELETE FROM entries');
}

export function* walkMarkdown(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}
