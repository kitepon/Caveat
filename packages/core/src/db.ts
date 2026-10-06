import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveRoleTexts } from './frontmatter.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, 'schema.sql');
const MIGRATIONS_DIR = join(here, 'migrations');

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export const stderrLogger: Logger = {
  info: (m) => process.stderr.write(`[caveat] ${m}\n`),
  warn: (m) => process.stderr.write(`[caveat:warn] ${m}\n`),
  error: (m) => process.stderr.write(`[caveat:error] ${m}\n`),
};

export interface OpenDbOptions {
  path: string;
  logger?: Logger;
}

export function openDb(opts: OpenDbOptions): DatabaseSync {
  const parent = dirname(opts.path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const db = new DatabaseSync(opts.path);
  try {
    // Native hooks and MCP share this index. A simultaneous markHit/reindex
    // write must get a bounded chance to finish instead of failing immediately.
    // Keep this below the shortest installed hook deadline (5 seconds).
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };

    if (user_version === 0) {
      db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
    } else {
      applyMigrations(db, user_version);
      backfillRoleTexts(db);
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Recompute topical_text / symptom_text for any pre-v3 rows that were carried
// across migration 003. New rows (v3 schema or v3 indexer write) populate
// these columns directly via upsertEntry, so this is a one-shot per-DB
// backfill that becomes a no-op once everything is filled in.
function backfillRoleTexts(db: DatabaseSync): void {
  let rows: Array<{
    rowid: number;
    title: string;
    body: string;
    tags: string | null;
    frontmatter_json: string;
  }>;
  try {
    rows = db
      .prepare(
        'SELECT rowid, title, body, tags, frontmatter_json FROM entries WHERE topical_text IS NULL',
      )
      .all() as Array<{
      rowid: number;
      title: string;
      body: string;
      tags: string | null;
      frontmatter_json: string;
    }>;
  } catch {
    // The columns can be absent on an extremely old DB that somehow skipped
    // migration 003 — defer to schema.sql / next openDb retry.
    return;
  }
  if (rows.length === 0) return;
  const upd = db.prepare(
    'UPDATE entries SET topical_text = ?, symptom_text = ? WHERE rowid = ?',
  );
  for (const r of rows) {
    const { topical, symptom } = deriveRoleTexts({
      title: r.title,
      body: r.body,
      tags: r.tags,
      frontmatter_json: r.frontmatter_json,
    });
    upd.run(topical, symptom, r.rowid);
  }
}

function applyMigrations(db: DatabaseSync, currentVersion: number): void {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const n = Number(file.split('_')[0]);
    if (n <= currentVersion) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${n}`);
  }
}
