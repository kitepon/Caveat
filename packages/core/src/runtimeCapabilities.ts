import { DatabaseSync } from 'node:sqlite';

export class UnsupportedSqliteRuntimeError extends Error {
  readonly code = 'CAVEAT_RUNTIME_UNSUPPORTED';
  readonly capability = 'sqlite_fts5_trigram';
  readonly node = process.version;
  readonly sqlite: string;

  constructor(sqlite: string, cause: Error) {
    super(`CAVEAT_RUNTIME_UNSUPPORTED: Node ${process.version}, SQLite ${sqlite} requires FTS5 with the trigram tokenizer. Use a Node build that provides this search capability. Original SQLite error: ${cause.message}`, { cause });
    this.name = 'UnsupportedSqliteRuntimeError';
    this.sqlite = sqlite;
  }
}

/** Probe the actual search engine before touching a persistent DB or installer state. */
export function assertSqliteSearchCapability() {
  const db = new DatabaseSync(':memory:');
  let sqlite = 'unknown';
  let failure: unknown;
  let failed = false;
  try {
    sqlite = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
    db.exec("CREATE VIRTUAL TABLE caveat_runtime_fts USING fts5(value, tokenize='trigram')");
    db.prepare('INSERT INTO caveat_runtime_fts(value) VALUES (?)').run('Caveat capability probe');
    const row = db.prepare('SELECT value FROM caveat_runtime_fts WHERE caveat_runtime_fts MATCH ?').get('ability') as { value: string } | undefined;
    if (row?.value !== 'Caveat capability probe') throw new Error('sqlite_fts5_trigram_probe_result_mismatch');
  } catch (error) {
    failed = true;
    // Only known capability absence is typed. Resource/unknown SQLite failures
    // keep their original identity and are never treated as expected refusal.
    failure = error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR'
      && /^(?:no such module: fts5|no such tokenizer: trigram)$/.test(error.message)
      ? new UnsupportedSqliteRuntimeError(sqlite, error) : error;
  }
  try {
    db.close();
  } catch (cleanup) {
    if (failed) {
      const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
      throw new AggregateError([failure, cleanup], `SQLite capability probe failed: ${describe(failure)}; cleanup failed: ${describe(cleanup)}`, { cause: failure });
    }
    throw cleanup;
  }
  if (failed) throw failure;
  return { node: process.version, sqlite, fts5Trigram: true as const };
}
