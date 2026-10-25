import { it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWindowsAclSession } from '../src/privateWindowsAclSession.js';
import ts from 'typescript';
const compiled=mkdtempSync(join(tmpdir(),'caveat-acl-worker-test-'));
writeFileSync(join(compiled,'package.json'),'{"type":"module"}');
for(const name of ['privateWindowsAcl','privateWindowsAclProtocol','privateWindowsAclWorker']) {
 const source=readFileSync(new URL('../src/'+name+'.ts',import.meta.url),'utf8');
 writeFileSync(join(compiled,name+'.js'),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
}
afterAll(()=>rmSync(compiled,{recursive:true,force:true}));
const workerUrl=pathToFileURL(join(compiled,'privateWindowsAclWorker.js'));
const helper=fileURLToPath(new URL('./fixtures/fake-acl-session.mjs',import.meta.url));
function fixture(mode?:string){const root=mkdtempSync(join(tmpdir(),'caveat-acl-session-')),log=join(root,'ops.jsonl');return {root,log,options:{workerUrl,timeoutMs:5000,workerOptions:{command:process.execPath,args:[helper,log,...(mode?[mode]:[])]}},rows(){return readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));},close(){rmSync(root,{recursive:true,force:true});}};}
it('never starts a worker or helper for an unused session',()=>{const s=createWindowsAclSession({workerUrl:new URL('file:///does-not-exist.mjs')});expect(()=>s.close()).not.toThrow();});
it('runs every check, in order, while reusing one helper and closing it',()=>{const f=fixture(),s=createWindowsAclSession(f.options);try{for(let n=0;n<13;n++)s.run('same-path',n%2===0,n%3===0);s.close();const rows=f.rows();expect(rows.filter(r=>r.kind==='start')).toHaveLength(1);expect(rows.filter(r=>r.kind==='operation')).toHaveLength(13);expect(rows.filter(r=>r.kind==='operation').map(({sequence,path,directory,apply})=>({sequence,path,directory,apply}))).toEqual(Array.from({length:13},(_,n)=>({sequence:n+1,path:'same-path',directory:n%2===0,apply:n%3===0})));expect(()=>s.run('later',false,false)).toThrow(/closed/);}finally{s.close();f.close();}});
it('preserves native rejection and retries the next store in a new interpreter',()=>{const f=fixture(),s=createWindowsAclSession(f.options);try{expect(()=>s.run('reject',false,false)).toThrow(/exit=42.*controlled rejection/);expect(()=>s.run('next-store',false,false)).not.toThrow();s.close();expect(f.rows().filter(r=>r.kind==='start')).toHaveLength(2);}finally{s.close();f.close();}});
it('rejects a wrong response sequence and restarts before another check',()=>{const f=fixture(),s=createWindowsAclSession(f.options);try{expect(()=>s.run('mismatch',false,false)).toThrow(/invalid response/);expect(()=>s.run('next-store',false,false)).not.toThrow();s.close();expect(f.rows().filter(r=>r.kind==='start')).toHaveLength(2);}finally{s.close();f.close();}});
it('returns worker import failure to the synchronous waiter instead of hanging',()=>{const f=fixture();const bad=join(f.root,'bad.mjs');writeFileSync(bad,'throw Object.assign(Error("controlled"),{code:"FIXTURE"});');const s=createWindowsAclSession({...f.options,workerUrl:pathToFileURL(bad)});try{expect(()=>s.run('x',false,false)).toThrow(/worker unavailable FIXTURE/);expect(()=>s.run('next-store',false,false)).toThrow(/worker unavailable/);expect(()=>s.close()).not.toThrow();}finally{s.close();f.close();}});
it('preserves a spawn failure without waiting for the hang guard',()=>{const f=fixture(),s=createWindowsAclSession({...f.options,workerOptions:{command:join(f.root,'no-such-executable')}});try{expect(()=>s.run('x',false,false)).toThrow(/spawn ENOENT/);expect(()=>s.close()).not.toThrow();}finally{s.close();f.close();}});
it('cancels a timed-out owned helper and leaves the next request usable',()=>{const f=fixture(),s=createWindowsAclSession({...f.options,timeoutMs:1000});try{s.run('ready',false,false);expect(()=>s.run('hang',false,false)).toThrow(/ETIMEDOUT/);expect(()=>s.run('next-store',false,false)).not.toThrow();s.close();expect(f.rows().filter(r=>r.kind==='start')).toHaveLength(2);}finally{s.close();f.close();}});
it('reports an interpreter that refuses EOF instead of claiming clean shutdown',()=>{const f=fixture('hang-on-close'),s=createWindowsAclSession(f.options);try{s.run('x',false,false);expect(()=>s.close()).toThrow(/powershell exit=/);}finally{s.close();f.close();}});

it('does not permit disabling or extending the production ACL guard',()=>{for(const timeoutMs of [0,Infinity,30001,NaN])expect(()=>createWindowsAclSession({timeoutMs})).toThrow(/invalid ACL timeout/);});

it('bounds helper output before accepting even a valid-looking oversized reply',()=>{const f=fixture(),s=createWindowsAclSession(f.options);try{expect(()=>s.run('oversized',false,false)).toThrow(/ENOBUFS/);expect(()=>s.run('next-store',false,false)).not.toThrow();}finally{s.close();f.close();}});
