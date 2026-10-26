import { openDb, readEntryDocument, createCachedContentKeyProvider } from '@caveat/core';
import type { Source } from '@caveat/core';
import type { CliContext } from '../context.js';

export interface ShowOptions {
  id?: string;
  source: Source;
  path?: string;
  offsetBytes?: number;
  limitBytes?: number;
}

export function runShow(ctx: CliContext, opts: ShowOptions): void {
  const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
  try {
    const result = readEntryDocument(db, ctx.paths, { ...opts, keyProvider: createCachedContentKeyProvider({ caveatHome: ctx.caveatHome }) });
    if (!result) {
      process.stdout.write(`(not found: ${opts.id} in ${opts.source})\n`);
      process.exitCode = 1;
      return;
    }
    if ('raw' in result) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    const fm = result.frontmatter;
    process.stdout.write(`id: ${fm.id}\n`);
    process.stdout.write(`title: ${fm.title}\n`);
    process.stdout.write(`source: ${result.source}\n`);
    process.stdout.write(`path: ${result.path}\n`);
    process.stdout.write(`visibility: ${fm.visibility}\n`);
    process.stdout.write(`confidence: ${fm.confidence}\n`);
    if (fm.outcome) process.stdout.write(`outcome: ${fm.outcome}\n`);
    if (fm.tags && fm.tags.length > 0) process.stdout.write(`tags: ${fm.tags.join(', ')}\n`);
    if (fm.last_verified) process.stdout.write(`last_verified: ${fm.last_verified}\n`);
    process.stdout.write(`created_at: ${fm.created_at}\n`);
    process.stdout.write(`updated_at: ${fm.updated_at}\n`);
    process.stdout.write('\n');
    process.stdout.write(result.body);
    if (!result.body.endsWith('\n')) process.stdout.write('\n');
  } finally {
    db.close();
  }
}
