import { readPeriodicSyncState, runPeriodicSync } from '@caveat/core';
import type { CliContext } from '../context.js';

export async function runAutosync(ctx: CliContext): Promise<void> {
  let result;
  try {
    result = await runPeriodicSync({ caveatHome: ctx.caveatHome, ownDir: ctx.paths.knowledgeRepo, paths: ctx.paths, logger: ctx.logger });
  } catch {
    // A state/lock storage failure still has a machine-readable, unsuccessful
    // result. Do not claim it was persisted or print paths from an exception.
    const at = new Date().toISOString();
    result = { schema: 'caveat.periodic_sync.v1', status: 'failed', reason: 'state_unavailable', started_at: at, finished_at: at };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'success' ? 0 : result.status === 'skipped' ? 2 : 1;
}

export function autosyncStatus(ctx: CliContext): void {
  process.stdout.write(`${JSON.stringify({ schema: 'caveat.periodic_sync_status.v1', state: readPeriodicSyncState(ctx.caveatHome) })}\n`);
}
