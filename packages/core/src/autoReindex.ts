import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { scanSource, walkMarkdown, type ScanResult } from './indexer.js';
import {
  detectSealedBundle,
  scanSealedSource,
} from './sealedIndex.js';
import type { Source } from './types.js';
import type { Logger } from './db.js';
import type { ResolvedPaths } from './paths.js';
import type { ContentKeyProvider } from './sealedKeys.js';

export interface EntriesDigest {
  digest: string;
  fileCount: number;
}

export interface DigestMarker extends EntriesDigest {
  generatedAt: string;
}

export interface FileLock {
  path: string;
}

export type ReindexLock = FileLock;

export interface ReindexResult {
  perSource: Record<string, ScanResult>;
  fileCount: number;
}

type SourceRoot =
  | { kind: 'plaintext'; source: Source; root: string }
  | { kind: 'sealed'; source: Source; bundlePath: string };

function sourceRoots(paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'>): SourceRoot[] {
  const roots: SourceRoot[] = [];
  if (existsSync(paths.entriesDir)) roots.push({ kind: 'plaintext', source: 'own', root: paths.entriesDir });
  if (!existsSync(paths.communityDir)) return roots;
  for (const entry of requireDirectories(paths.communityDir)) {
    const repoDir = join(paths.communityDir, entry);
    const bundlePath = detectSealedBundle(repoDir);
    if (bundlePath) {
      roots.push({ kind: 'sealed', source: `community/${entry}`, bundlePath });
      continue;
    }
    const root = join(paths.communityDir, entry, 'entries');
    if (existsSync(root)) roots.push({ kind: 'plaintext', source: `community/${entry}`, root });
  }
  return roots;
}

function requireDirectories(root: string): string[] {
  // Kept small and synchronous: this runs on a detached worker except for
  // digest checks, where it must exactly mirror scanSource's walk.
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function computeEntriesDigest(
  paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'>,
): EntriesDigest {
  const lines: string[] = [];
  for (const sourceRoot of sourceRoots(paths)) {
    if (sourceRoot.kind === 'sealed') {
      const stat = statSync(sourceRoot.bundlePath);
      lines.push(`${sourceRoot.source}\tbundle\t${stat.mtimeMs}\t${stat.size}`);
      continue;
    }
    for (const filePath of walkMarkdown(sourceRoot.root)) {
      const stat = statSync(filePath);
      const rel = relative(sourceRoot.root, filePath).replace(/\\/g, '/');
      lines.push(`${sourceRoot.source}\t${rel}\t${stat.mtimeMs}\t${stat.size}`);
    }
  }
  lines.sort();
  return {
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
    fileCount: lines.length,
  };
}

function indexDir(caveatHome: string): string {
  return join(caveatHome, 'index');
}

function digestMarkerPath(caveatHome: string): string {
  return join(indexDir(caveatHome), '.entries-digest');
}

export function readDigestMarker(caveatHome: string): DigestMarker | null {
  try {
    const value = JSON.parse(readFileSync(digestMarkerPath(caveatHome), 'utf-8')) as unknown;
    if (
      value !== null && typeof value === 'object' &&
      typeof (value as DigestMarker).digest === 'string' &&
      typeof (value as DigestMarker).fileCount === 'number' &&
      typeof (value as DigestMarker).generatedAt === 'string'
    ) return value as DigestMarker;
  } catch {
    // Missing and malformed markers are intentionally both dirty.
  }
  return null;
}

export function writeDigestMarker(caveatHome: string, value: EntriesDigest): void {
  const dir = indexDir(caveatHome);
  mkdirSync(dir, { recursive: true });
  const path = digestMarkerPath(caveatHome);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...value, generatedAt: new Date().toISOString() }), 'utf-8');
  renameSync(temporary, path);
}

function lockPath(caveatHome: string): string {
  return join(indexDir(caveatHome), '.reindex-lock');
}

function tryCreateLock(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function acquireFileLock(lockFilePath: string): FileLock | null {
  mkdirSync(dirname(lockFilePath), { recursive: true });
  if (tryCreateLock(lockFilePath)) return { path: lockFilePath };

  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockFilePath, 'utf-8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return tryCreateLock(lockFilePath) ? { path: lockFilePath } : null;
    return null;
  }
  try {
    process.kill(pid, 0);
    return null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') return null;
  }
  try {
    unlinkSync(lockFilePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return tryCreateLock(lockFilePath) ? { path: lockFilePath } : null;
}

export function releaseFileLock(lock: FileLock): void {
  try {
    unlinkSync(lock.path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function acquireReindexLock(caveatHome: string): ReindexLock | null {
  return acquireFileLock(lockPath(caveatHome));
}

export function releaseReindexLock(lock: ReindexLock): void {
  releaseFileLock(lock);
}

export function reindexAllSources(opts: {
  db: DatabaseSync;
  paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'> & Partial<Pick<ResolvedPaths, 'caveatHome'>>;
  force?: boolean;
  logger: Logger;
  keyProvider?: ContentKeyProvider;
}): ReindexResult {
  const { db, paths, logger, keyProvider } = opts;
  const perSource: Record<string, ScanResult> = {};
  if (existsSync(paths.entriesDir)) {
    try {
      perSource.own = withSourceSavepoint(db, () =>
        scanSource({ db, source: 'own', entriesRoot: paths.entriesDir, force: opts.force }),
      );
    } catch (err) {
      logger.warn(`own: reindex failed; preserving existing rows: ${errorMessage(err)}`);
    }
  } else {
    logger.warn(`entries dir not found; preserving own index rows: ${paths.entriesDir}`);
  }

  const presentCommunitySources = new Set<string>();
  if (existsSync(paths.communityDir)) {
    for (const handle of requireDirectories(paths.communityDir)) {
      const source: Source = `community/${handle}`;
      const repoDir = join(paths.communityDir, handle);
      presentCommunitySources.add(source);
      const bundlePath = detectSealedBundle(repoDir);
      if (bundlePath) {
        if (!keyProvider) {
          logger.warn(`${source}: sealed bundle found but no keyProvider was supplied; preserving existing rows`);
          continue;
        }
        try {
          perSource[source] = withSourceSavepoint(db, () =>
            scanSealedSource({ db, source, bundlePath, keyProvider }),
          );
        } catch (err) {
          logger.warn(`${source}: sealed reindex failed; preserving existing rows: ${errorMessage(err)}`);
        }
        continue;
      }
      const root = join(repoDir, 'entries');
      if (!existsSync(root)) continue;
      try {
        perSource[source] = withSourceSavepoint(db, () =>
          scanSource({ db, source, entriesRoot: root, force: opts.force }),
        );
      } catch (err) {
        logger.warn(`${source}: reindex failed; preserving existing rows: ${errorMessage(err)}`);
      }
    }
  }
  const rows = db.prepare("SELECT DISTINCT source FROM entries WHERE source LIKE 'community/%'").all() as Array<{ source: string }>;
  for (const { source } of rows) {
    if (presentCommunitySources.has(source)) continue;
    db.prepare('DELETE FROM entries WHERE source = ?').run(source);
  }

  if (paths.caveatHome) {
    const file = join(paths.caveatHome, 'index', 'entry-input-diagnostics.json');
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { diagnostics?: import('./entryRead.js').EntryReadDiagnostic[] } : {};
    const diagnostics = [...(previous.diagnostics ?? []).filter(d => !Object.hasOwn(perSource, d.source) && (d.source === 'own' || presentCommunitySources.has(d.source))), ...Object.values(perSource).flatMap(r => r.diagnostics ?? [])];
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ scope: 'latest successful per-source index scans; stale rows are preserved', observed_at: new Date().toISOString(), diagnostics }) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  }
  return { perSource, fileCount: computeEntriesDigest(paths).fileCount };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withSourceSavepoint<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('SAVEPOINT reindex_source');
  try {
    const result = fn();
    db.exec('RELEASE SAVEPOINT reindex_source');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT reindex_source');
      db.exec('RELEASE SAVEPOINT reindex_source');
    } catch {
      // Preserve the original source-level failure for the warning path.
    }
    throw err;
  }
}
