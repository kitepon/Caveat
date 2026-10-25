import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
vi.mock('@caveat/core', async (original) => ({ ...await original<typeof import('@caveat/core')>(), observeRuntimeError: vi.fn() }));
import { openDb, resolvePaths, loadConfig, observeRuntimeError, ENTRY_LIMITS } from '@caveat/core';
import { registerAllTools } from '../src/registerTools.js';import type { McpContext } from '../src/context.js';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'caveat-mcp-contract-')), paths=resolvePaths(root,'own',root);mkdirSync(paths.entriesDir,{recursive:true});
 const db=openDb({path:':memory:'}), written=vi.fn();
 const ctx:McpContext={caveatHome:root,userHome:root,userConfigPath:join(root,'.caveatrc.json'),paths,db,config:loadConfig(join(root,'.caveatrc.json')),logger:{info(){},warn(){},error(){}},onEntryWritten:written};
 const tools=new Map<string,{schema:z.ZodObject;call:(args:unknown)=>Promise<{isError?:boolean;content:Array<{text:string}>}>}>();
 registerAllTools({registerTool(name:string,config:{inputSchema:z.ZodObject},call:unknown){tools.set(name,{schema:config.inputSchema,call:call as never});}} as unknown as McpServer,ctx,'0.21.2');
 return {root,db,written,call:(name:string,args:unknown)=>{const t=tools.get(name)!;return t.call(t.schema.parse(args));},close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
describe('MCP input refusal contract',()=>{
 it('counts unknown arguments as well as schema fields, returns typed isError, and keeps the next request usable',async()=>{
  const f=fixture();vi.mocked(observeRuntimeError).mockClear();try{
   const args={title:'too big',symptom:'small',visibility:'private',extra:'x'.repeat(ENTRY_LIMITS.arguments)};
   const result=await f.call('caveat_record',args);expect(result.isError).toBe(true);expect(JSON.parse(result.content[0]!.text)).toMatchObject({code:'CAVEAT.ENTRY_INPUT_CONSTRAINT',field:'arguments',actual:Buffer.byteLength(JSON.stringify(args)),limit:ENTRY_LIMITS.arguments});
   expect(f.db.prepare('SELECT COUNT(*) n FROM entries').get()).toMatchObject({n:0});expect(f.written).not.toHaveBeenCalled();expect(observeRuntimeError).not.toHaveBeenCalled();
   const next=await f.call('caveat_record',{title:'next request',symptom:'normal',visibility:'private'});expect(next.isError).not.toBe(true);expect(f.written).toHaveBeenCalledOnce();
  }finally{f.close();}
 });
 it('rejects an in-budget update whose final file would exceed budget without changing any stored state',async()=>{
  const f=fixture();vi.mocked(observeRuntimeError).mockClear();try{
   const created=JSON.parse((await f.call('caveat_record',{title:'existing',symptom:'normal',visibility:'private'})).content[0]!.text);
   const before=readFileSync(created.filePath),row=f.db.prepare('SELECT * FROM entries').get();f.written.mockClear();
   const base={id:created.id,patch:{sections:{Symptom:''}}};base.patch.sections.Symptom='x'.repeat(ENTRY_LIMITS.arguments-Buffer.byteLength(JSON.stringify(base)));
   expect(Buffer.byteLength(JSON.stringify(base))).toBe(ENTRY_LIMITS.arguments);
   const refused=await f.call('caveat_update',base);expect(refused.isError).toBe(true);expect(JSON.parse(refused.content[0]!.text).field).toBe('entry_markdown');
   expect(readFileSync(created.filePath)).toEqual(before);expect(f.db.prepare('SELECT * FROM entries').get()).toEqual(row);expect(f.written).not.toHaveBeenCalled();expect(observeRuntimeError).not.toHaveBeenCalled();
  }finally{f.close();}
 });
 it('continues reporting unknown database failures as mutation_outcome_unverified',async()=>{
  const f=fixture();vi.mocked(observeRuntimeError).mockClear();try{
   f.db.exec('DROP TABLE entries');await expect(f.call('caveat_record',{title:'database failure',symptom:'normal',visibility:'private'})).rejects.toThrow();
   expect(observeRuntimeError).toHaveBeenCalledWith('CAVEAT.MCP_TOOL_FAILED',{version:'0.21.2',impact:'mutation_outcome_unverified'});
  }finally{f.close();}
 });
});
