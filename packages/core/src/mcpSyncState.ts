import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type McpSyncState = {
  schema: 'caveat.mcp_sync.v1';
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt?: string;
  code?: string;
  phase?: 'inspect' | 'pull' | 'push' | 'fetch';
  committed?: boolean;
  pulled?: boolean;
  pushed?: boolean;
  changedFiles?: number;
};
const statePath = (home: string) => join(home, 'sync', 'mcp-sync.json');

/** Project a bounded, non-secret receipt; never return arbitrary stored fields. */
export function readMcpSyncState(home: string): McpSyncState | { status: 'unavailable'; code: string } | null {
  try {
    const path = statePath(home), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error('invalid');
    const v = JSON.parse(readFileSync(path, 'utf8'));
    if (v.schema !== 'caveat.mcp_sync.v1' || !['running','success','failed'].includes(v.status) || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v.startedAt)) throw Error('invalid');
    const out: McpSyncState = {schema:v.schema,status:v.status,startedAt:v.startedAt};
    if (v.finishedAt !== undefined) { if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v.finishedAt)) throw Error('invalid'); out.finishedAt=v.finishedAt; }
    if (v.code !== undefined) { if (typeof v.code !== 'string' || !/^(CAVEAT_[A-Z_]+|SYNC_BUSY|SYNC_CONFLICT|NOT_A_REPO|EXTERNAL_TOPLEVEL|DETACHED_HEAD|NO_REMOTE|REMOTE_PUBLIC|REMOTE_VISIBILITY_INDETERMINATE|REBASE_IN_PROGRESS|WORKTREE_DIRTY|OWN_REPO_EXISTS|BOTH_HAVE_ENTRIES)$/.test(v.code)) throw Error('invalid'); out.code=v.code; }
    if (v.phase !== undefined) { if (!['inspect','pull','push','fetch'].includes(v.phase)) throw Error('invalid'); out.phase=v.phase; }
    for (const k of ['committed','pulled','pushed'] as const) if (v[k] !== undefined) { if (typeof v[k] !== 'boolean') throw Error('invalid'); out[k]=v[k]; }
    if (v.changedFiles !== undefined) { if (!Number.isSafeInteger(v.changedFiles) || v.changedFiles<0) throw Error('invalid'); out.changedFiles=v.changedFiles; }
    return out;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : {status:'unavailable',code:'CAVEAT_MCP_SYNC_STATE_INVALID'};
  }
}

export function writeMcpSyncState(home: string, state: McpSyncState): void {
  const dir = join(home,'sync');
  mkdirSync(dir,{recursive:true,mode:0o700});
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw Error('CAVEAT_MCP_SYNC_STATE_UNAVAILABLE');
  const temporary = join(dir, `.mcp-sync-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(state)+'\n', {encoding:'utf8',mode:0o600,flag:'wx'});
  renameSync(temporary,statePath(home));
}
