import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{readMcpSyncState,writeMcpSyncState}from'../src/mcpSyncState.js';
it('stores a safe late result and refuses malformed receipts without leaking arbitrary fields',()=>{
 const home=mkdtempSync(join(tmpdir(),'caveat-sync-state-'));
 try{
  expect(readMcpSyncState(home)).toBeNull();
  const state={schema:'caveat.mcp_sync.v1' as const,status:'success' as const,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),pushed:true,changedFiles:1};
  writeMcpSyncState(home,state);expect(readMcpSyncState(home)).toEqual(state);
  const path=join(home,'sync','mcp-sync.json');const bytes=readFileSync(path,'utf8');writeFileSync(path,JSON.stringify({...state,remote:'secret.invalid'}));expect(readMcpSyncState(home)).toEqual(state);
  for(const invalid of ['null','{',JSON.stringify({...state,startedAt:'private text'}),JSON.stringify({...state,phase:'secret'}),JSON.stringify({...state,code:'credential=private'})]){
   writeFileSync(path,invalid);expect(readMcpSyncState(home)).toEqual({status:'unavailable',code:'CAVEAT_MCP_SYNC_STATE_INVALID'});
  }
  writeFileSync(path,bytes);expect(readMcpSyncState(home)).toEqual(state);
 }finally{rmSync(home,{recursive:true,force:true});}
});
