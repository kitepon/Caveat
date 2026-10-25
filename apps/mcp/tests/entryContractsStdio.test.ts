import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';import { join, resolve } from 'node:path';import { tmpdir } from 'node:os';
it('refuses an oversized request below the SDK transport limit, then records/searches and raw-reads on the same stdio connection',async()=>{
 const root=mkdtempSync(join(tmpdir(),'caveat-contract-stdio-'));const home=join(root,'home'),caveatHome=join(home,'.caveat');mkdirSync(home,{recursive:true});mkdirSync(caveatHome,{recursive:true});writeFileSync(join(home,'.caveatrc.json'),JSON.stringify({runtimeErrors:true}));
 const env={...process.env,HOME:home,USERPROFILE:home,CAVEAT_HOME:caveatHome,XDG_STATE_HOME:join(root,'state'),LOCALAPPDATA:join(root,'state'),CAVEAT_AUTO_SYNC:'off'} as Record<string,string>;
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('../cli/dist/caveat.js'),'mcp-server'],env,stderr:'pipe'});
 const client=new Client({name:'caveat-contract-test',version:'1'});let stderr='';transport.stderr?.on('data',x=>stderr+=x.toString());
 try{
  await client.connect(transport);
  expect((await client.listTools()).tools.map(x=>x.name)).toContain("caveat_get");
  const refused=await client.callTool({name:'caveat_record',arguments:{title:'must not write',symptom:'small',visibility:'private',extra:'x'.repeat(7*1024*1024)}});
  expect(refused.isError).toBe(true);expect(JSON.parse((refused.content as Array<{text:string}>)[0]!.text)).toMatchObject({code:'CAVEAT.ENTRY_INPUT_CONSTRAINT',field:'arguments'});
  const created=await client.callTool({name:'caveat_record',arguments:{title:'stdio continuation',symptom:'wire continuation needle',visibility:'private'}});expect(created.isError).not.toBe(true);
  const searched=await client.callTool({name:'caveat_search',arguments:{query:'continuation'}});expect(searched.isError).not.toBe(true);expect(JSON.parse((searched.content as Array<{text:string}>)[0]!.text)).toHaveLength(1);
  const entries=join(caveatHome,'own','entries');mkdirSync(entries,{recursive:true});const content='---\nvalue: '+'['.repeat(129)+'0'+']'.repeat(129)+'\n---\nraw entry';writeFileSync(join(entries,'deep.md'),content);
  const raw=await client.callTool({name:'caveat_get',arguments:{path:'deep.md',limitBytes:32}});expect(raw.isError).not.toBe(true);expect(JSON.parse((raw.content as Array<{text:string}>)[0]!.text)).toMatchObject({kind:'raw_entry',raw:{offset_bytes:0,total_bytes:Buffer.byteLength(content),length_bytes:32}});
  expect(existsSync(join(root,'state/caveat/runtime-errors.json'))).toBe(false);expect(stderr).not.toMatch(/CAVEAT.MCP_TOOL_FAILED|\[caveat:fatal\]/);
 }finally{await client.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},20000);
