import { createHash } from 'node:crypto';
import { ENTRY_LIMITS, EntryInputConstraintError } from './entryConstraints.js';
import { constraintDiagnostic, type EntryReadDiagnostic } from './entryRead.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readSealedHeader, unsealBundle } from './sealedBundle.js';
import type { ContentKeyProvider } from './sealedKeys.js';
import { buildEntryUpsertRow, upsertEntry, type UpsertRow, type ScanResult } from './indexer.js';
import type { ResolvedPaths } from './paths.js';
import type { Source } from './types.js';

export interface SealedKeyPrewarmFailure {
  source: Source;
  error: unknown;
}

export function detectSealedBundle(communityRepoDir: string): string | null {
  const path = join(communityRepoDir, 'bundle', 'entries.caveat');
  return existsSync(path) ? path : null;
}

function communityRepoDirs(paths: Pick<ResolvedPaths, 'communityDir'>): string[] {
  if (!existsSync(paths.communityDir)) return [];
  return readdirSync(paths.communityDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(paths.communityDir, entry.name));
}

export async function prewarmSealedKeys(opts: {
  paths: Pick<ResolvedPaths, 'communityDir'>;
  keyProvider: ContentKeyProvider;
}): Promise<SealedKeyPrewarmFailure[]> {
  const failures: SealedKeyPrewarmFailure[] = [];
  await Promise.all(communityRepoDirs(opts.paths).map(async (repoDir) => {
    const source: Source = `community/${basename(repoDir)}`;
    try {
      const bundlePath = detectSealedBundle(repoDir);
      if (!bundlePath) return;
      const { header } = readSealedHeader(readFileSync(bundlePath));
      await opts.keyProvider.ensureKeyAvailable(header.keyId, header.keyserverUrl);
    } catch (error) {
      failures.push({ source, error });
    }
  }));
  return failures;
}

export function scanSealedSource(opts: {
  db: DatabaseSync;
  source: Source;
  bundlePath: string;
  keyProvider: ContentKeyProvider;
  now?: () => string;
}): ScanResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const bundle = readFileSync(opts.bundlePath);
  const { header } = readSealedHeader(bundle);
  const contentKey = opts.keyProvider.resolveContentKey(header.keyId, header.keyserverUrl);
  const unsealed = unsealBundle(bundle, contentKey);
  const bundleMtime = statSync(opts.bundlePath).mtime.toISOString();

  opts.db.exec('DROP TABLE IF EXISTS temp.touched');
  opts.db.exec('CREATE TEMP TABLE touched(rowid INTEGER PRIMARY KEY)');
  const insertTouched = opts.db.prepare('INSERT INTO touched (rowid) VALUES (?)');

  const diagnostics: EntryReadDiagnostic[] = [];
  let added = 0;
  let updated = 0;
  try {
    for (const file of unsealed.files) {
      if (!file.relPath.endsWith('.md')) continue;
      // Plaintext from sealed community bundles remains in process memory only;
      // the durable boundary is SQLite index rows, never decrypted markdown files.
      let row: UpsertRow;
      try {
        if (file.content.length > ENTRY_LIMITS.markdown) throw new EntryInputConstraintError('entry_markdown', ENTRY_LIMITS.markdown, file.content.length);
        row = buildEntryUpsertRow({
        source: opts.source,
        path: file.relPath,
        content: file.content.toString('utf-8'),
        file_mtime: bundleMtime,
        indexed_at: now(),
      }); } catch (error) {
        if (!(error instanceof EntryInputConstraintError)) throw error;
        diagnostics.push(constraintDiagnostic(opts.db, opts.source, file.relPath, createHash('sha256').update(file.content).digest('hex'), error, now()));
        for (const old of opts.db.prepare('SELECT rowid FROM entries WHERE source = ? AND path = ?').all(opts.source, file.relPath) as Array<{rowid:number}>) insertTouched.run(old.rowid);
        continue;
      }
      const existing = opts.db
        .prepare('SELECT rowid FROM entries WHERE source = ? AND id = ?')
        .get(opts.source, row.id) as { rowid: number } | undefined;
      const rowid = upsertEntry(opts.db, row);
      insertTouched.run(rowid);
      if (existing) updated++;
      else added++;
    }

    const del = opts.db
      .prepare('DELETE FROM entries WHERE source = ? AND rowid NOT IN (SELECT rowid FROM touched)')
      .run(opts.source);
    return { added, updated, deleted: Number(del.changes), ...(diagnostics.length ? { diagnostics } : {}) };
  } finally {
    opts.db.exec('DROP TABLE IF EXISTS temp.touched');
  }
}
