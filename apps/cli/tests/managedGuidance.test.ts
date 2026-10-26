import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{fileURLToPath}from'node:url';import{spawnSync}from'node:child_process';
import{openDb,recordEntry,appendPendingReminder}from'@caveat/core';
for(const adapter of ['hook','codex-hook','cursor-hook'])it(`${adapter} uses managed MCP guidance from the native home even with a separate CAVEAT_HOME`,()=>{
 const root=mkdtempSync(join(tmpdir(),'caveat-managed-hook-')),home=join(root,'home'),caveatHome=join(root,'data'),entries=join(caveatHome,'own','entries');mkdirSync(entries,{recursive:true});mkdirSync(join(home,'.caveat-deploy','managed-v1'),{recursive:true});writeFileSync(join(home,'.caveatrc.json'),JSON.stringify({jevEnabled:false}));
 const db=openDb({path:join(caveatHome,'index','caveat.db')});recordEntry({title:'node-gyp build failed during pnpm install',symptom:'node-gyp build failed during pnpm install',visibility:'private'},{db,entriesRoot:entries,source:'own'});db.close();
 appendPendingReminder(caveatHome,'_global','autosync: own sync failed (UNKNOWN). run `caveat sync` to resolve.');
 try{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../dist/caveat.js',import.meta.url)),adapter,'user-prompt-submit'],{input:JSON.stringify({session_id:'fixture',prompt:'node-gyp build failed during pnpm install'}),encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,HOME:home,USERPROFILE:home,CAVEAT_HOME:caveatHome,CAVEAT_AUTO_SYNC:'off',CAVEAT_INDEX_AUTOSYNC:'off',XDG_STATE_HOME:join(root,'state'),LOCALAPPDATA:join(root,'state')}});
  expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('caveat_get');expect(result.stdout).toContain('caveat_sync');expect(result.stdout).not.toContain('mcp__caveat__');expect(result.stdout).not.toMatch(/caveat (show|index|sync)\b/);
 }finally{rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},20000);
