import { it, expect } from 'vitest';import { spawnSync } from 'node:child_process';import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';import { join,resolve } from 'node:path';import { tmpdir } from 'node:os';import { openDb,recordEntry } from '@caveat/core';
it('full index retains a rejected old row, lists diagnostics, and CLI show returns explicit raw windows',()=>{
 const root=mkdtempSync(join(tmpdir(),'caveat-cli-entry-contract-')),home=join(root,'profile'),caveatHome=join(home,'.caveat'),entries=join(caveatHome,'own','entries');mkdirSync(entries,{recursive:true});
 const env={...process.env,HOME:home,USERPROFILE:home,CAVEAT_HOME:caveatHome,XDG_STATE_HOME:join(root,'state'),LOCALAPPDATA:join(root,'state')};const db=openDb({path:join(caveatHome,'index','caveat.db')});const created=recordEntry({title:'preserve',symptom:'needle old'},{db,entriesRoot:entries});db.close();const old=readFileSync(created.filePath,'utf8');writeFileSync(created.filePath,old+'x'.repeat(1024*1024));
 const run=(args:string[])=>spawnSync(process.execPath,[resolve('dist/caveat.js'),...args],{env,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
 try{
  const indexed=run(['index','--full']);expect(indexed.status,indexed.stderr).toBe(0);
  const status=run(['entry-diagnostics','--json']);expect(status.status,status.stderr).toBe(0);expect(JSON.parse(status.stdout).diagnostics).toEqual([expect.objectContaining({id:created.id,index_state:'stale_preserved'})]);
  const search=run(['search','needle']);expect(search.status,search.stderr).toBe(0);expect(search.stdout).toContain(created.id);
  const show=run(['show','--path',created.path,'--limit-bytes','32']);expect(show.status,show.stderr).toBe(0);expect(JSON.parse(show.stdout)).toMatchObject({kind:'raw_entry',raw:{offset_bytes:0,length_bytes:32,next_offset_bytes:32}});
  expect(readFileSync(created.filePath,'utf8')).toBe(old+'x'.repeat(1024*1024));
 }finally{rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},20000);
