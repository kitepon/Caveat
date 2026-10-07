import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  computeEntriesDigest,
  createKeyserverKeyProvider,
  openDb,
  prewarmSealedKeys,
  observeRuntimeError,
  rebuildAll,
  reindexAllSources,
  writeDigestMarker,
} from '@caveat/core';
import { CAVEAT_VERSION } from '../version.js';
import type { CliContext } from '../context.js';

export interface IndexOptions {
  full: boolean;
}

export async function runIndex(ctx: CliContext, opts: IndexOptions): Promise<void> {
  const dbDir = dirname(ctx.paths.dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const keyProvider = createKeyserverKeyProvider({ caveatHome: ctx.caveatHome });
  const failures = await prewarmSealedKeys({ paths: ctx.paths, keyProvider });
  for (const failure of failures) {
    ctx.logger.warn(`${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}`);
  }

  let db;
  try {
    db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  } catch (error) {
    observeRuntimeError('CAVEAT.DATABASE_OPEN_FAILED', { version: CAVEAT_VERSION, impact: 'feature_unavailable' });
    throw error;
  }
  try {
    if (opts.full) {
      ctx.logger.info('full rebuild: DELETE FROM entries');
      rebuildAll(db);
    }

    const result = reindexAllSources({ db, paths: ctx.paths, logger: ctx.logger, keyProvider });
    for (const [source, scan] of Object.entries(result.perSource)) {
      if (source === 'own') {
        ctx.logger.info(`own: +${scan.added} ~${scan.updated} -${scan.deleted}`);
      } else {
        ctx.logger.info(`${source}: +${scan.added} ~${scan.updated} -${scan.deleted}`);
      }
    }
    writeDigestMarker(ctx.caveatHome, computeEntriesDigest(ctx.paths));
  } catch (error) {
    observeRuntimeError('CAVEAT.INDEX_FAILED', { version: CAVEAT_VERSION, impact: 'feature_unavailable' });
    throw error;
  } finally {
    db.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
