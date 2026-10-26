import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Frontmatter, Source } from './types.js';
import { parseMarkdown } from './frontmatter.js';
import { buildEntry } from './writer.js';
import { upsertEntry } from './indexer.js';

const IMMUTABLE_KEYS: ReadonlySet<keyof Frontmatter> = new Set([
  'id',
  'created_at',
  'source_session',
  'source_project',
]);

export interface UpdatePatch {
  frontmatter?: Partial<Frontmatter>;
  sections?: Record<string, string>;
}

export interface UpdateOptions {
  db: DatabaseSync;
  entriesRoot: string;
  source?: Source;
  now?: () => Date;
}

export interface UpdateResult {
  id: string;
  path: string;
  filePath: string;
}

export function updateEntry(id: string, patch: UpdatePatch, opts: UpdateOptions): UpdateResult {
  const source: Source = opts.source ?? 'own';
  if (source !== 'own') {
    throw new Error('community エントリは購読物です; 編集は上流で行ってください');
  }
  const now = opts.now ?? (() => new Date());
  const nowDate = now();

  const row = opts.db
    .prepare('SELECT path FROM entries WHERE source = ? AND id = ?')
    .get(source, id) as { path: string } | undefined;
  if (!row) {
    throw new Error(`caveat not found: id=${id} source=${source}`);
  }

  const relPath = row.path;
  const filePath = join(opts.entriesRoot, relPath);
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseMarkdown(raw, { allowOversizedBody: true });

  if (patch.frontmatter) {
    for (const key of Object.keys(patch.frontmatter) as Array<keyof Frontmatter>) {
      if (IMMUTABLE_KEYS.has(key)) {
        throw new Error(`immutable frontmatter key: ${key}`);
      }
    }
  }

  const ymd = formatYmd(nowDate);
  const mergedFrontmatter: Frontmatter = {
    ...parsed.frontmatter,
    ...(patch.frontmatter ?? {}),
    environment: {
      ...parsed.frontmatter.environment,
      ...(patch.frontmatter?.environment ?? {}),
    },
    id: parsed.frontmatter.id,
    source_session: parsed.frontmatter.source_session,
    source_project: parsed.frontmatter.source_project,
    created_at: parsed.frontmatter.created_at,
    updated_at: ymd,
  };
  if (patch.frontmatter?.tags !== undefined) {
    mergedFrontmatter.tags = patch.frontmatter.tags;
  }

  const mergedSections: Record<string, string> = { ...parsed.sections };
  if (patch.sections) {
    for (const [heading, content] of Object.entries(patch.sections)) {
      const normalized = heading.trim().toLowerCase();
      const existingKey = Object.keys(mergedSections).find(
        (h) => h.trim().toLowerCase() === normalized,
      );
      if (existingKey) {
        mergedSections[existingKey] = content;
      } else {
        mergedSections[heading] = content;
      }
    }
  }

  const built = buildEntry(mergedFrontmatter, mergedSections);
  writeFileSync(filePath, built.content, 'utf-8');

  const stat = statSync(filePath);
  upsertEntry(opts.db, {
    id,
    source,
    path: relPath,
    title: mergedFrontmatter.title,
    body: built.body,
    frontmatter_json: JSON.stringify(mergedFrontmatter),
    tags: JSON.stringify(mergedFrontmatter.tags),
    confidence: mergedFrontmatter.confidence,
    visibility: mergedFrontmatter.visibility,
    file_mtime: stat.mtime.toISOString(),
    indexed_at: nowDate.toISOString(),
  });

  return { id, path: relPath, filePath };
}

function formatYmd(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
