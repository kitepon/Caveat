import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ENTRY_LIMITS, EntryInputConstraintError, assertEntryArguments, serializedArgumentsUtf8Bytes } from '../src/entryConstraints.js';
import { loadFrontmatter, dumpFrontmatter, EntryFrontmatterFormatError } from '../src/frontmatterCodec.js';
import { buildEntry } from '../src/writer.js'; import { parseMarkdown } from '../src/frontmatter.js';
import { recordEntry } from '../src/record.js'; import { updateEntry } from '../src/update.js';
import { scanSource } from '../src/indexer.js'; import { search } from '../src/repository.js';
import { reindexAllSources } from '../src/autoReindex.js';
import { readEntryDocument, readEntryIndexDiagnostics } from '../src/entryRead.js';
import { openDb } from '../src/db.js'; import { resolvePaths } from '../src/paths.js';
import { findBlockedFiles } from '../src/visibilityGate.js';
const fm = { id:'sample',title:'ordinary title',visibility:'private' as const,confidence:'tentative' as const,tags:[],environment:{},source_project:null,source_session:'session',created_at:'2026-10-25',updated_at:'2026-10-25' };
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'caveat-entry-contract-')), paths=resolvePaths(root,'own',root), db=openDb({path:':memory:'});mkdirSync(paths.entriesDir,{recursive:true});
 return {root,paths,db,close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
describe('entry input contract',()=>{
 it('counts serialized UTF-8 arguments, including Unicode and JSON escapes, at the exact boundary',()=>{
  const overhead=Buffer.byteLength(JSON.stringify({text:''}));const exact={text:'x'.repeat(ENTRY_LIMITS.arguments-overhead)};
  expect(()=>assertEntryArguments(exact)).not.toThrow();expect(()=>assertEntryArguments({text:exact.text+'x'})).toThrow(EntryInputConstraintError);
  expect(()=>assertEntryArguments({text:'\0'.repeat(200000)})).toThrow(EntryInputConstraintError);
  expect(()=>assertEntryArguments({text:'😀'.repeat(300000)})).toThrow(EntryInputConstraintError);
 });
 it('counts deeply nested JSON without a recursive stringify or a transport override',()=>{
  const value: Record<string,unknown>={};let at=value;for(let i=0;i<20000;i++){const next={};at.x=next;at=next;}
  expect(serializedArgumentsUtf8Bytes(value)).toBe(120002);expect(()=>assertEntryArguments(value)).not.toThrow();
  const ordinary={emoji:'😀',escape:'\0',items:[null,1,true,'x'],nested:{x:'y'}};expect(serializedArgumentsUtf8Bytes(ordinary)).toBe(Buffer.byteLength(JSON.stringify(ordinary)));
 });
 it('keeps legacy numeric semantics and selectively quotes ambiguous strings and keys',()=>{
  expect(loadFrontmatter('x: 1_000\ny: 0b1_0\nz: 1_0.5\n')).toEqual({x:1000,y:2,z:10.5});
  const value={ordinary:'normal title',numeric:'1_000',yes:'yes',date:'2026-10-25',timestamp:'2026-10-25T07:00:00Z','1_000':'1_0.5'};
  const raw=dumpFrontmatter(value);expect(raw).toContain('ordinary: normal title');expect(raw).toMatch(/numeric: ['"]1_000['"]/);expect(raw).toMatch(/date: ['"]2026-10-25['"]/);expect(loadFrontmatter(raw)).toEqual(value);
 });
 it('enforces the raw frontmatter UTF-8 boundary before loading or dumping',()=>{
  const overhead=Buffer.byteLength('value: \n');
  const exact='value: '+'é'.repeat((ENTRY_LIMITS.frontmatter-overhead)/2)+'\n';
  expect(Buffer.byteLength(exact)).toBe(ENTRY_LIMITS.frontmatter);
  expect(()=>loadFrontmatter(exact)).not.toThrow();
  expect(()=>loadFrontmatter(exact+' ')).toThrow(EntryInputConstraintError);
  const within={value:'é'.repeat((ENTRY_LIMITS.frontmatter-overhead)/2)};
  expect(Buffer.byteLength(dumpFrontmatter(within))).toBe(ENTRY_LIMITS.frontmatter);
  expect(()=>dumpFrontmatter({value:within.value+'x'})).toThrow(EntryInputConstraintError);
 });
 it('accepts depth110 and rejects parser depth, cycles and expanded alias graphs before dump',()=>{
  expect(()=>loadFrontmatter('value: '+'['.repeat(110)+'0'+']'.repeat(110))).not.toThrow();
  expect(()=>loadFrontmatter('value: '+'['.repeat(129)+'0'+']'.repeat(129))).toThrow(EntryInputConstraintError);
  const cycle:Record<string,unknown>={};cycle.self=cycle;expect(()=>dumpFrontmatter(cycle)).toThrow(EntryInputConstraintError);
  expect(()=>loadFrontmatter('a: &a [1,2,3,4,5,6,7,8,9,10]\nb: &b ['+Array(100).fill('*a').join(',')+']\nc: ['+Array(100).fill('*b').join(',')+']')).toThrow(EntryInputConstraintError);
  const shared={x:'x'.repeat(40000)};expect(()=>dumpFrontmatter({a:shared,b:shared})).toThrow(EntryInputConstraintError);
 });
 it('accepts the final Markdown byte boundary and refuses the next byte',()=>{
  const overhead=Buffer.byteLength(buildEntry(fm,{Symptom:'x'}).content)-1;const text='x'.repeat(ENTRY_LIMITS.markdown-overhead);
  expect(Buffer.byteLength(buildEntry(fm,{Symptom:text}).content)).toBe(ENTRY_LIMITS.markdown);expect(()=>buildEntry(fm,{Symptom:text+'x'})).toThrow(EntryInputConstraintError);
 });
 it('rejects record/update before file, index and updated_at mutation',()=>{
  const f=fixture();try{
   expect(()=>recordEntry({title:'huge',symptom:'x'.repeat(ENTRY_LIMITS.markdown)},{db:f.db,entriesRoot:f.paths.entriesDir})).toThrow(EntryInputConstraintError);
   expect(f.db.prepare('SELECT COUNT(*) n FROM entries').get()).toMatchObject({n:0});
   const created=recordEntry({title:'small',symptom:'needle before'},{db:f.db,entriesRoot:f.paths.entriesDir});const before=readFileSync(created.filePath),row=f.db.prepare('SELECT * FROM entries').get();
   expect(()=>updateEntry(created.id,{sections:{Symptom:'x'.repeat(ENTRY_LIMITS.markdown)}},{db:f.db,entriesRoot:f.paths.entriesDir,now:()=>new Date('2027-01-01')})).toThrow(EntryInputConstraintError);
   expect(digest(readFileSync(created.filePath))).toBe(digest(before));expect(f.db.prepare('SELECT * FROM entries').get()).toEqual(row);
  }finally{f.close();}
 });
 it('can reduce an oversized existing body without requiring an unbounded YAML parser',()=>{
  const f=fixture();try{const r=recordEntry({title:'small',symptom:'before'},{db:f.db,entriesRoot:f.paths.entriesDir});const original=readFileSync(r.filePath,'utf8');writeFileSync(r.filePath,original.replace('## Symptom\n\nbefore','## Symptom\n\n'+'x'.repeat(ENTRY_LIMITS.markdown)));
   expect(()=>updateEntry(r.id,{sections:{Symptom:'small after'}},{db:f.db,entriesRoot:f.paths.entriesDir})).not.toThrow();expect(parseMarkdown(readFileSync(r.filePath,'utf8')).sections.Symptom).toBe('small after');
  }finally{f.close();}
 });
 it('preserves stale rows, reports new skipped entries, and leaves search available',()=>{
  const f=fixture();try{
   const r=recordEntry({title:'indexed',symptom:'needle existing'},{db:f.db,entriesRoot:f.paths.entriesDir});const bad=readFileSync(r.filePath,'utf8')+'x'.repeat(ENTRY_LIMITS.markdown);writeFileSync(r.filePath,bad);
   writeFileSync(join(f.paths.entriesDir,'new.md'),'---\nid: new\nvalue: '+'['.repeat(129)+'0'+']'.repeat(129)+'\n---\nbody');
   const result=reindexAllSources({db:f.db,paths:f.paths,force:true,logger:{info(){},warn(){},error(){}}});
   expect(result.perSource.own?.diagnostics).toHaveLength(2);expect(search(f.db,{query:'needle'})).toHaveLength(1);
   const saved=readEntryIndexDiagnostics(f.root);expect(saved.diagnostics.map(x=>x.index_state).sort()).toEqual(['skipped','stale_preserved']);expect(saved.diagnostics.find(x=>x.path===r.path)?.sha256).toBe(digest(bad));
   expect(existsSync(join(f.root,'index/entry-input-diagnostics.json'))).toBe(true);
  }finally{f.close();}
 });
 it('raw get reads unindexed/deep files in explicit complete UTF-8 windows without changing them',()=>{
  const f=fixture();try{
   const content='---\nvalue: '+'['.repeat(129)+'0'+']'.repeat(129)+'\n---\n😀終わり';const file=join(f.paths.entriesDir,'deep.md');writeFileSync(file,content);
   let offset=0;const chunks:string[]=[];for(;;){const result=readEntryDocument(f.db,f.paths,{path:'deep.md',offsetBytes:offset,limitBytes:17});expect(result).toHaveProperty('kind','raw_entry');if(!result||!('raw' in result))throw Error('raw response missing');chunks.push(result.raw.content);if(result.raw.next_offset_bytes===null)break;offset=result.raw.next_offset_bytes;}
   expect(chunks.join('')).toBe(content);expect(readFileSync(file,'utf8')).toBe(content);expect(()=>readEntryDocument(f.db,f.paths,{path:'../secret.md'})).toThrow();
  }finally{f.close();}
 });
 it('rejects named non-YAML engines before gray-matter can execute or bypass the codec',()=>{
  const source='\ufeff---javascript\n({visibility: \"private\"})\n---\nbody';
  expect(()=>parseMarkdown(source)).toThrow(EntryFrontmatterFormatError);expect(findBlockedFiles([{path:'entries/private.md',content:source}])).toEqual(['entries/private.md']);
 });
 it('cannot bypass the privacy gate with oversized private frontmatter',()=>{
  const content='---\nvisibility: private\nx: '+ 'a'.repeat(ENTRY_LIMITS.frontmatter)+'\n---\nbody';expect(findBlockedFiles([{path:'entries/private.md',content}])).toEqual(['entries/private.md']);
 });
});
