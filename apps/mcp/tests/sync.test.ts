import { isolatedGitEnv } from '../../../scripts/test-git-env.mjs';
import { expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync } from 'node:fs';
import { join } from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {syncClient} from './fixtures/syncClient.js';
import {readMcpSyncState} from '../../../packages/core/src/mcpSyncState.js';
import {acquireReindexLock,releaseFileLock} from '../../../packages/core/src/autoReindex.js';
import {readAutoSyncState,writeAutoSyncState,autoSyncLockPath} from '../../../packages/core/src/autoSync.js';
import {runAutoSync} from '../../../packages/core/src/autoSync.js';
vi.mock('@caveat/core',async()=>import('../../../packages/core/src/index.js'));
// Only anonymous privacy probing is replaced; repository, locks, sync, Git and the slow remote are real.
vi.mock('../../../packages/core/src/remoteVisibility.js',async original=>({...await original<object>(),probeAnonymousRead:async()=>({kind:'denied',status:401})}));
afterEach(()=>vi.unstubAllEnvs());
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
it('keeps a slow push alive after MCP client timeout, rejects overlap and persists the late result',async()=>{
 const root=mkdtempSync(join(tmpdir(),'caveat-mcp-sync-')),home=join(root,'home'),own=join(home,'.caveat','own'),caveatHome=join(home,'.caveat'),remote=join(root,'remote.git');
 mkdirSync(own,{recursive:true});
 const env={...process.env,...Object.fromEntries(Object.entries(isolatedGitEnv(home)).map(([k,v])=>[k,/^GIT_CONFIG/i.test(k)?undefined:v])),HOME:home,USERPROFILE:home,CAVEAT_HOME:caveatHome,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
 for(const[k,v]of Object.entries(env))vi.stubEnv(k,v);
 const git=(cwd:string,args:string[])=>{const r=spawnSync('git',['-C',cwd,...args],{env:{...env,...isolatedGitEnv(home)},encoding:'utf8',windowsHide:true,timeout:10000});expect(r.status,r.stderr).toBe(0);return r.stdout.trim();};
 git(root,['init','--bare',remote]);git(own,['init','-b','main']);writeFileSync(join(own,'README.md'),'initial\n');git(own,['add','.']);git(own,['commit','-m','initial']);git(own,['remote','add','origin',remote]);git(own,['push','-u','origin','main']);
 const entered=join(root,'entered');const delay=join(root,'delay.mjs');writeFileSync(delay,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(entered)},'entered');setTimeout(()=>{},700);`);
 const quote=(s:string)=>"'"+s.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'";
 const hook=join(remote,'hooks','pre-receive');writeFileSync(hook,`#!/bin/sh\n${quote(process.execPath)} ${quote(delay)}\n`);chmodSync(hook,0o755);
 const mcp=await syncClient({userHome:home,caveatHome,onEntryWritten:()=>{}});
 try{
  writeAutoSyncState(caveatHome,{finishedAt:new Date().toISOString(),signature:'fixture',ownSync:{consecutiveFailureSignature:'fixture',consecutiveFailureCount:3}});
  writeFileSync(join(own,'README.md'),'new private fixture\n');
  const call=mcp.client.callTool({name:'caveat_sync',arguments:{}},undefined,{timeout:300});const timeout=expect(call).rejects.toThrow(/timed out/i);
  for(let i=0;i<300&&!existsSync(entered);i++)await sleep(10);expect(existsSync(entered)).toBe(true);
  await timeout;
  expect(readMcpSyncState(caveatHome)).toMatchObject({status:'running'});
  const before=Date.now();const overlap=await mcp.client.callTool({name:'caveat_sync',arguments:{}});expect(overlap.isError).toBe(true);expect(JSON.stringify(overlap)).toContain('SYNC_BUSY');expect(Date.now()-before).toBeLessThan(500);
  const auto=await runAutoSync({caveatHome,ownDir:own,paths:mcp.ctx.paths,logger:mcp.ctx.logger});expect(auto).toMatchObject({ran:false,skipReason:'index_busy'});
  for(let i=0;i<300&&readMcpSyncState(caveatHome)?.status==='running';i++)await sleep(10);
  expect(readMcpSyncState(caveatHome)).toMatchObject({status:'success',pushed:true});expect(git(remote,['rev-parse','main'])).toBe(git(own,['rev-parse','HEAD']));
  expect(readAutoSyncState(caveatHome)?.ownSync?.consecutiveFailureCount).toBe(0);
  const previous=readFileSync(join(caveatHome,'sync','mcp-sync.json'),'utf8');
  const lock=acquireReindexLock(caveatHome)!;expect(lock).not.toBeNull();
  try{const busy=await mcp.client.callTool({name:'caveat_sync',arguments:{}});expect(JSON.stringify(busy)).toContain('SYNC_BUSY');expect(readFileSync(join(caveatHome,'sync','mcp-sync.json'),'utf8')).toBe(previous);}finally{releaseFileLock(lock);}
  rmSync(entered);writeFileSync(join(own,'README.md'),'autosync private fixture\n');
  const autosync=runAutoSync({caveatHome,ownDir:own,paths:mcp.ctx.paths,logger:mcp.ctx.logger});
  for(let i=0;i<300&&!existsSync(entered);i++)await sleep(10);expect(existsSync(entered)).toBe(true);
  const duringAuto=await mcp.client.callTool({name:'caveat_sync',arguments:{}});expect(duringAuto.isError).toBe(true);expect(JSON.stringify(duringAuto)).toContain('SYNC_BUSY');
  expect(readFileSync(join(caveatHome,'sync','mcp-sync.json'),'utf8')).toBe(previous);
  expect(await autosync).toMatchObject({ran:true,outcome:{own:{disposition:'success'}}});
  expect(existsSync(autoSyncLockPath(caveatHome))).toBe(false);
  const secret='fixture-private-cause-sentinel';writeFileSync(hook,`#!/bin/sh\necho '${secret}' >&2\nexit 1\n`);
  writeFileSync(join(own,'README.md'),'refused push fixture\n');
  const failed=await mcp.client.callTool({name:'caveat_sync',arguments:{}});expect(failed.isError).toBe(true);expect(JSON.stringify(failed)).toContain('CAVEAT_SYNC_REMOTE_FAILED');expect(JSON.stringify(failed)).toContain('push');expect(JSON.stringify(failed)).not.toContain(secret);
  expect(readMcpSyncState(caveatHome)).toMatchObject({status:'failed',code:'CAVEAT_SYNC_REMOTE_FAILED',phase:'push'});

 }finally{await mcp.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});expect(existsSync(root)).toBe(false);}
},20000);

it('reports a missing own repository as NOT_A_REPO and persists the terminal result without initializing it',async()=>{
 const root=mkdtempSync(join(tmpdir(),'caveat-mcp-missing-')),home=join(root,'home'),caveatHome=join(home,'.caveat'),own=join(caveatHome,'own');
 mkdirSync(home,{recursive:true});
 for(const key of Object.keys(process.env))if(/^GIT_CONFIG/i.test(key))vi.stubEnv(key,undefined);
 for(const [key,value]of Object.entries(isolatedGitEnv(home)))vi.stubEnv(key,/^GIT_CONFIG/i.test(key)?undefined:value);
 const mcp=await syncClient({userHome:home,caveatHome,onEntryWritten:()=>{}});
 try{
  const result=await mcp.client.callTool({name:'caveat_sync',arguments:{}});
  expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('NOT_A_REPO');
  expect(readMcpSyncState(caveatHome)).toMatchObject({status:'failed',code:'NOT_A_REPO',finishedAt:expect.any(String)});
  expect(existsSync(own)).toBe(false);
  const tool=(await mcp.client.listTools()).tools.find(row=>row.name==='caveat_sync');
  expect(tool?.description).toContain('never initialize or infer a remote automatically');
 }finally{await mcp.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
