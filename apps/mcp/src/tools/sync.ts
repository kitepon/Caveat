import {
  acquireReindexLock, releaseFileLock, syncOwn, resetAutoSyncFailureState,
  SyncError, SyncRemoteError, SyncRecoveryError, observeRuntimeError,
  readMcpSyncState, writeMcpSyncState, type McpSyncState,
} from '@caveat/core';
import type { McpContext } from '../context.js';

const pending = new Set<Promise<unknown>>();
export async function waitForMcpSyncs(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** A client cancellation never cancels the repository transaction. */
export function handleSync(ctx: McpContext, productVersion: string) {
  let lock;
  try { lock = acquireReindexLock(ctx.caveatHome); }
  catch { return Promise.resolve({status:'failed' as const,code:'CAVEAT_MCP_SYNC_STATE_UNAVAILABLE'}); }
  if (!lock) return Promise.resolve({status:'failed' as const,code:'SYNC_BUSY',lastResult:readMcpSyncState(ctx.caveatHome)});
  const job = (async () => {
    const startedAt = new Date().toISOString();
    const base = {schema:'caveat.mcp_sync.v1' as const,startedAt};
    let state: McpSyncState;
    try {
      writeMcpSyncState(ctx.caveatHome,{...base,status:'running'});
      try {
        const r = await syncOwn({ownDir:ctx.paths.knowledgeRepo,caveatHome:ctx.caveatHome,paths:ctx.paths,
          githubUser:ctx.config.githubUser,logger:{info:()=>{},warn:()=>{},error:()=>{}},heldReindexLock:lock});
        state = {...base,status:'success',finishedAt:new Date().toISOString(),committed:r.committed,pulled:r.pulled,pushed:r.pushed,changedFiles:r.changedFiles};
        try { resetAutoSyncFailureState(ctx.caveatHome); } catch { /* CLI also treats backoff reset as best-effort. */ }
      } catch (error) {
        if (!(error instanceof SyncError || error instanceof SyncRemoteError)) observeRuntimeError('CAVEAT.SYNC_FAILED',
          {version:productVersion,impact:error instanceof SyncRecoveryError?'recovery_failed':'operation_failed'});
        state = {...base,status:'failed',finishedAt:new Date().toISOString(),
          code:error instanceof SyncError?error.code:error instanceof SyncRemoteError?'CAVEAT_SYNC_REMOTE_FAILED':error instanceof SyncRecoveryError?'CAVEAT_SYNC_RECOVERY_FAILED':'CAVEAT_SYNC_FAILED',
          ...(error instanceof SyncRemoteError?{phase:error.phase}:{})};
      }
      writeMcpSyncState(ctx.caveatHome,state);
      return state;
    } catch {
      return {...base,status:'failed' as const,code:'CAVEAT_MCP_SYNC_STATE_UNAVAILABLE'};
    } finally { releaseFileLock(lock); }
  })();
  const safe = job.catch(() => ({status:'failed' as const,code:'CAVEAT_MCP_SYNC_STATE_UNAVAILABLE'}));
  pending.add(safe);
  void safe.then(()=>pending.delete(safe));
  return safe;
}
