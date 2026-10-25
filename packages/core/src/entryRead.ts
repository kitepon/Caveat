import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, statSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ResolvedPaths } from './paths.js';
import type { Source, GetResult } from './types.js';
import { get } from './repository.js';
import { readSealedHeader, unsealBundle } from './sealedBundle.js';
import type { ContentKeyProvider } from './sealedKeys.js';
import { parseMarkdown } from './frontmatter.js';
import { ENTRY_LIMITS, EntryInputConstraintError } from './entryConstraints.js';
export interface EntryReadDiagnostic {
  source: Source; path: string; id: string | null; sha256: string; observed_at: string;
  constraint: ReturnType<EntryInputConstraintError['toJSON']>;
  index_state: 'skipped' | 'stale_preserved'; preserved_index_ids: string[];
}
export function constraintDiagnostic(db: DatabaseSync, source: Source, path: string, sha256: string, error: EntryInputConstraintError, at = new Date().toISOString()): EntryReadDiagnostic {
  const rows = db.prepare('SELECT id FROM entries WHERE source = ? AND path = ?').all(source, path) as Array<{ id: string }>;
  return { source, path, id: rows.length === 1 ? rows[0]!.id : null, sha256, observed_at: at, constraint: error.toJSON(), index_state: rows.length ? 'stale_preserved' : 'skipped', preserved_index_ids: rows.map(r => r.id) };
}
export function fileSha256(file: string): string {
  const hash = createHash('sha256'), fd = openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024);
  try { for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; hash.update(buffer.subarray(0, n)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
export interface RawEntryRead {
  kind: 'raw_entry'; source: Source; path: string; diagnostics: EntryReadDiagnostic[];
  raw: { encoding: 'utf8' | 'base64'; content: string; offset_bytes: number; length_bytes: number; total_bytes: number; next_offset_bytes: number | null };
}
export function entryFilePath(paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'>, source: Source, entryPath: string): string {
  const handle = /^community\/([^/\\]+)$/.exec(source)?.[1];
  if (source !== 'own' && (!handle || handle === '.' || handle === '..')) throw Error('invalid entry source');
  const root = source === 'own' ? paths.entriesDir : join(paths.communityDir, handle!, 'entries');
  if (isAbsolute(entryPath) || entryPath.split(/[\\/]/).some(p => p === '..') || !entryPath.endsWith('.md')) throw Error('invalid entry path');
  const target = join(root, entryPath), rel = relative(realpathSync(root), realpathSync(target));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw Error('entry path escapes source');
  return target;
}
export function readEntryDocument(db: DatabaseSync, paths: Pick<ResolvedPaths, 'entriesDir' | 'communityDir'> & Partial<Pick<ResolvedPaths, 'caveatHome'>>, options: { id?: string; source?: Source; path?: string; offsetBytes?: number; limitBytes?: number; keyProvider?: ContentKeyProvider }): GetResult | RawEntryRead | null {
  const source = options.source ?? 'own';
  const indexed = options.id ? get(db, options.id, source) : null;
  const rel = options.path ?? indexed?.path; if (!rel) return null;
  let sealedContent: Buffer | undefined, file: string | undefined;
  const handle = /^community\/([^/\\]+)$/.exec(source)?.[1];
  const bundlePath = handle && handle !== '.' && handle !== '..' ? join(paths.communityDir, handle, 'bundle', 'entries.caveat') : undefined;
  if (bundlePath && existsSync(bundlePath)) {
    if (indexed && options.path === undefined) {
      const diagnostics = paths.caveatHome ? readEntryIndexDiagnostics(paths.caveatHome).diagnostics.filter(d => d.source === source && d.path === rel) : [];
      return diagnostics.length ? Object.assign(indexed, { index_diagnostics: diagnostics, read_scope: 'cached index; use explicit path for raw sealed content' }) : indexed;
    }
    if (isAbsolute(rel) || rel.split(/[\\/]/).some(p => p === '..') || !rel.endsWith('.md')) throw Error('invalid entry path');
    if (!options.keyProvider) { if (indexed) return indexed; throw Error('sealed entry raw reading requires its existing content key'); }
    const bundle = readFileSync(bundlePath), { header } = readSealedHeader(bundle);
    const key = options.keyProvider.resolveContentKey(header.keyId, header.keyserverUrl);
    sealedContent = unsealBundle(bundle, key).files.find(f => f.relPath === rel)?.content;
    if (!sealedContent) return null;
  } else file = entryFilePath(paths, source, rel);
  const size = sealedContent?.length ?? statSync(file!).size;
  const digest = () => sealedContent ? createHash('sha256').update(sealedContent).digest('hex') : fileSha256(file!);
  let diagnostic: EntryReadDiagnostic | undefined;
  if (size > ENTRY_LIMITS.markdown) diagnostic = constraintDiagnostic(db, source, rel, digest(), new EntryInputConstraintError('entry_markdown', ENTRY_LIMITS.markdown, size));
  else {
    try {
      const parsed = parseMarkdown(sealedContent ? sealedContent.toString('utf8') : readFileSync(file!, 'utf8'));
      if (indexed && options.path === undefined) return indexed;
      return { id: parsed.frontmatter.id, source, path: rel, ...parsed };
    } catch (error) {
      if (!(error instanceof EntryInputConstraintError)) throw error;
      diagnostic = constraintDiagnostic(db, source, rel, digest(), error);
    }
  }
  const offset = options.offsetBytes ?? 0, limit = options.limitBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || !Number.isSafeInteger(limit) || limit < 4 || limit > 64 * 1024) throw Error('raw entry range: offset must be within file, limit must be 4..65536 bytes');
  let buffer: Buffer, count: number;
  if (sealedContent) { buffer = sealedContent.subarray(offset, offset + limit + 4); count = buffer.length; }
  else {
    const fd = openSync(file!, 'r'); buffer = Buffer.alloc(Math.min(size - offset, limit + 4));
    try { count = readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
  }
  if (count && (buffer[0]! & 0xc0) === 0x80) throw Error('raw entry offset must be a UTF-8 boundary');
  let n = Math.min(count, limit); while (n > 0 && n < count && (buffer[n]! & 0xc0) === 0x80) n--;
  const bytes = buffer.subarray(0, n); let encoding: 'utf8' | 'base64' = 'utf8', content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { encoding = 'base64'; content = bytes.toString('base64'); }
  return { kind: 'raw_entry', source, path: rel, diagnostics: [diagnostic], raw: { encoding, content, offset_bytes: offset, length_bytes: n, total_bytes: size, next_offset_bytes: offset + n < size ? offset + n : null } };
}
export function readEntryIndexDiagnostics(caveatHome: string): { scope: string; observed_at?: string; diagnostics: EntryReadDiagnostic[] } {
  const file = join(caveatHome, 'index', 'entry-input-diagnostics.json');
  if (!existsSync(file)) return { scope: 'no saved index scan diagnostics; run caveat index', diagnostics: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}
