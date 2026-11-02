import type { DatabaseSync } from 'node:sqlite';
import type {
  SearchFilters,
  SearchResult,
  GetResult,
  Source,
  Confidence,
  Visibility,
} from './types.js';
import { extractSections } from './frontmatter.js';

const SYMPTOM_EXCERPT_LENGTH = 200;

/**
 * Sanitize a user-provided query for FTS5 MATCH. Strips all non-letter /
 * non-digit / non-CJK chars (which collide with FTS5 operators like `:`, `.`,
 * `-`, `+`, `*`, `"`, `(`, `)`), then wraps each remaining token in double
 * quotes to force phrase-literal treatment. Empty input returns empty string.
 */
export function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  return tokens.map((t) => `"${t}"`).join(' ');
}

interface EntryRow {
  rowid: number;
  id: string;
  source: string;
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

export interface SearchOptions {
  query?: string;
  filters?: SearchFilters;
  limit?: number;
}

export function search(db: DatabaseSync, opts: SearchOptions = {}): SearchResult[] {
  const rawQuery = opts.query?.trim() ?? '';
  const ftsQuery = rawQuery ? sanitizeFtsQuery(rawQuery) : '';
  const filters = opts.filters ?? {};
  const limit = opts.limit ?? 50;

  const conditions: string[] = [];
  const params: unknown[] = [];

  let sql: string;
  if (ftsQuery) {
    sql = `SELECT e.* FROM entries_fts f JOIN entries e ON e.rowid = f.rowid WHERE entries_fts MATCH ?`;
    params.push(ftsQuery);
  } else {
    sql = `SELECT e.* FROM entries e WHERE 1=1`;
  }

  if (filters.source === 'own') {
    conditions.push(`e.source = 'own'`);
  } else if (filters.source === 'community') {
    conditions.push(`e.source LIKE 'community/%'`);
  }

  if (filters.confidence && filters.confidence.length > 0) {
    const placeholders = filters.confidence.map(() => '?').join(',');
    conditions.push(`e.confidence IN (${placeholders})`);
    params.push(...filters.confidence);
  }

  if (filters.visibility === 'public' || filters.visibility === 'private') {
    conditions.push(`e.visibility = ?`);
    params.push(filters.visibility);
  }

  if (conditions.length) sql += ' AND ' + conditions.join(' AND ');
  if (!ftsQuery) {
    sql += ` ORDER BY json_extract(e.frontmatter_json, '$.updated_at') DESC`;
  }
  sql += ' LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...(params as never[])) as unknown as EntryRow[];

  const results: SearchResult[] = [];
  for (const row of rows) {
    if (filters.tags && filters.tags.length > 0) {
      const entryTags = JSON.parse(row.tags || '[]') as string[];
      if (!filters.tags.every((t) => entryTags.includes(t))) continue;
    }
    results.push(toSearchResult(row));
  }
  return results;
}

export function get(db: DatabaseSync, id: string, source: Source = 'own'): GetResult | null {
  const row = db
    .prepare('SELECT * FROM entries WHERE source = ? AND id = ?')
    .get(source, id) as unknown as EntryRow | undefined;
  if (!row) return null;
  const fm = JSON.parse(row.frontmatter_json);
  return {
    id: row.id,
    source: row.source as Source,
    path: row.path,
    frontmatter: fm,
    sections: extractSections(row.body),
    body: row.body,
  };
}

export function listRecent(db: DatabaseSync, limit = 20): SearchResult[] {
  const rows = db.prepare(
    `SELECT e.* FROM entries e
     ORDER BY json_extract(e.frontmatter_json, '$.updated_at') DESC
     LIMIT ?`,
  ).all(limit) as unknown as EntryRow[];
  return rows.map(toSearchResult);
}

export function toSearchResult(row: EntryRow): SearchResult {
  const fm = JSON.parse(row.frontmatter_json);
  const symptomMatch = /##\s+Symptom\s*\n([\s\S]*?)(?=\n##|\n*$)/.exec(row.body);
  const symptom = symptomMatch?.[1]?.trim() ?? row.body;
  return {
    id: row.id,
    source: row.source as Source,
    title: row.title,
    symptomExcerpt: symptom.slice(0, SYMPTOM_EXCERPT_LENGTH),
    confidence: row.confidence as Confidence,
    visibility: (row.visibility as Visibility) ?? 'private',
    environment: fm.environment ?? {},
  };
}
