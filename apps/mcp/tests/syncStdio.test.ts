import {it,expect} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync} from 'node:fs';import{join,resolve}from'node:path';import{tmpdir}from'node:os';import{spawnSync}from'node:child_process';
it('exposes the compiled own-sync tool over stdio and reads its refused result through deployment status',async()=>{
 const root=mkdtempSync(join(tmpdir(),'caveat-sync-stdio-')),home=join(root,'home'),caveatHome=join(home,'.caveat'),own=join(caveatHome,'own');mkdirSync(own,{recursive:true});
 const env={...process.env,HOME:home,USERPROFILE:home,CAVEAT_HOME:caveatHome,CAVEAT_AUTO_SYNC:'off',XDG_STATE_HOME:join(root,'state'),LOCALAPPDATA:join(root,'state')}as Record<string,string>;
 const git=spawnSync('git',['-C',own,'init','-b','main'],{encoding:'utf8',env,windowsHide:true,timeout:10000});expect(git.status,git.stderr).toBe(0);
 const cli=resolve('../cli/dist/caveat.js');const transport=new StdioClientTransport({command:process.execPath,args:[cli,'mcp-server'],env,stderr:'pipe'});const client=new Client({name:'sync-stdio-fixture',version:'1'});
 let stderr='';transport.stderr?.on('data',chunk=>stderr+=chunk.toString());
 try{
  await client.connect(transport);const tool=(await client.listTools()).tools.find(t=>t.name==='caveat_sync');expect(tool?.annotations?.openWorldHint).toBe(true);expect(tool?.annotations?.readOnlyHint).not.toBe(true);
  const result=await client.callTool({name:'caveat_sync',arguments:{}});expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('NO_REMOTE');
  const status=spawnSync(process.execPath,[cli,'deployment','status','--json'],{env,encoding:'utf8',windowsHide:true,timeout:10000});expect(status.error).toBeUndefined();expect(status.stdout,status.stderr).not.toBe('');const projection=JSON.parse(status.stdout);expect(projection.ownSync).toMatchObject({status:'failed',code:'NO_REMOTE'});
  expect(JSON.parse(readFileSync(join(caveatHome,'sync','mcp-sync.json'),'utf8'))).toMatchObject(projection.ownSync);expect(stderr).not.toContain('CAVEAT.SYNC_FAILED');
 }finally{await client.close();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});expect(existsSync(root)).toBe(false);}
},20000);
