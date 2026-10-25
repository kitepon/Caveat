import { it, expect } from 'vitest';import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';import { createHash } from 'node:crypto';
import { sealBundle } from '../src/sealedBundle.js';import { scanSealedSource } from '../src/sealedIndex.js';import { createCachedContentKeyProvider } from '../src/sealedKeys.js';import { readEntryDocument } from '../src/entryRead.js';import { openDb } from '../src/db.js';import { resolvePaths } from '../src/paths.js';import { buildEntry } from '../src/writer.js';
it('preserves a sealed stale index and raw-reads the oversized source only in memory with an existing key',()=>{
 const home=mkdtempSync(join(tmpdir(),'caveat-sealed-contract-')),paths=resolvePaths(home,'own',home),db=openDb({path:':memory:'});
 const key=Buffer.alloc(32,7),keyId='keyserver:entry-contract',url='https://keys.example.test',file=join(paths.communityDir,'team','bundle','entries.caveat');mkdirSync(join(paths.communityDir,'team','bundle'),{recursive:true});mkdirSync(join(home,'keys'));
 const cache=join(home,'keys',createHash('sha256').update(url+'\n'+keyId).digest('hex').slice(0,32)+'.json');writeFileSync(cache,JSON.stringify({keyserverUrl:url,keyId,key:key.toString('base64')}));const provider=createCachedContentKeyProvider({caveatHome:home});
 const normal=buildEntry({id:'sealed',title:'sealed',visibility:'public',confidence:'confirmed',tags:[],environment:{},source_project:null,source_session:'s',created_at:'2026-01-01',updated_at:'2026-01-01'},{Symptom:'needle'}).content;
 const write=(content:string)=>writeFileSync(file,sealBundle({files:[{relPath:'sealed.md',content:Buffer.from(content)}],contentKey:key,keyId,keyserverUrl:url}));
 try{
  write(normal);expect(scanSealedSource({db,source:'community/team',bundlePath:file,keyProvider:provider}).added).toBe(1);
  const huge=normal+'x'.repeat(1024*1024);write(huge);const scan=scanSealedSource({db,source:'community/team',bundlePath:file,keyProvider:provider});expect(scan.diagnostics?.[0]).toMatchObject({source:'community/team',path:'sealed.md',index_state:'stale_preserved'});expect(scan.deleted).toBe(0);
  const raw=readEntryDocument(db,paths,{source:'community/team',path:'sealed.md',limitBytes:32,keyProvider:provider});expect(raw).toHaveProperty('kind','raw_entry');expect(existsSync(join(paths.communityDir,'team','entries'))).toBe(false);
  const bytes=readFileSync(cache);provider.resolveContentKey(keyId,url);expect(readFileSync(cache)).toEqual(bytes);
  writeFileSync(cache,'{broken');expect(()=>provider.resolveContentKey(keyId,url)).toThrow(/unavailable/);expect(readFileSync(cache,'utf8')).toBe('{broken');
 }finally{db.close();rmSync(home,{recursive:true,force:true});}
});
