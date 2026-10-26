import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import https from 'node:https';import net from 'node:net';
import { spawnSync } from 'node:child_process';import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGit } from '../src/gitRuntime.js';import { readAutoSyncState } from '../src/autoSync.js';import { readPeriodicSyncState } from '../src/periodicSync.js';
import { runInit } from '../../../apps/cli/src/commands/init.js';
import { runHook } from '../../../apps/cli/src/commands/hookCmd.js';
import { runAutosync } from '../../../apps/cli/src/commands/autosync.js';
import { buildContext } from '../../../apps/cli/src/context.js';
import { runSync } from '../../../apps/cli/src/commands/sync.js';
const adapter = vi.hoisted(() => ({ helper: '', proxy: '' }));
// Only the credential backend and HTTP endpoint are fixtures. All sync callers, simple-git and Git are real.
vi.mock('../src/githubCredential.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/githubCredential.js')>();
  const { fileURLToPath } = await import('node:url');
  const quote = (s: string) => "'" + s.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
  const asset = fileURLToPath(new URL('../src/githubCredentialHelper.js', import.meta.url));
  return { ...actual, githubGitConfig: (user?: string | null, baseDir?: string, env?: NodeJS.ProcessEnv) => actual.githubGitConfig(user, baseDir, env).map(s => s.replace(quote(asset), quote(adapter.helper)))
    .concat(user == null ? [] : [`http.https://github.com/.proxy=${adapter.proxy}`]) };
});
vi.mock('@caveat/core', async () => import('../src/index.js'));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const previousExit = process.exitCode;
afterEach(() => { vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();process.exitCode=previousExit;adapter.helper='';adapter.proxy=''; });

async function fixture(run: (f: { root: string; home: string; own: string; caveatHome: string; marker: string; forbidden: string; ctx: ReturnType<typeof buildContext>; git: (args: string[]) => string }) => Promise<void>) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'caveat-real-git-')),home=path.join(root,'home'),own=path.join(root,'own'),caveatHome=path.join(root,'caveat');
  for(const p of [home,own,caveatHome])fs.mkdirSync(p,{mode:0o700});
  const marker=path.join(root,'selected.jsonl'),forbidden=path.join(root,'forbidden');
  const sockets=new Set<net.Socket>();const track=(s:net.Socket)=>{sockets.add(s);s.on('close',()=>sockets.delete(s));};
  const tls=https.createServer({key:fs.readFileSync(new URL('./fixtures/github-loopback/key.pem',import.meta.url)),cert:fs.readFileSync(new URL('./fixtures/github-loopback/cert.pem',import.meta.url))},(req,res)=>{if(req.headers.authorization)fs.writeFileSync(forbidden,'unexpected authorization header');res.writeHead(401,{'WWW-Authenticate':'Basic realm="fixture"'});res.end('fixture only');});
  const proxy=http.createServer();tls.on('connection',track);proxy.on('connection',track);
  await new Promise<void>(r=>tls.listen(0,'127.0.0.1',r));const tlsPort=(tls.address()as net.AddressInfo).port;
  proxy.on('connect',(req,socket,head)=>{if(req.url!=='github.com:443'){socket.destroy();return;}const upstream=net.connect(tlsPort,'127.0.0.1');track(upstream);upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());upstream.once('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});});
  await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));adapter.proxy=`http://127.0.0.1:${(proxy.address()as net.AddressInfo).port}`;
  adapter.helper=path.join(root,'credential-fixture.mjs');
  const built=fileURLToPath(new URL('../dist/githubCredentialHelper.js',import.meta.url));
  fs.writeFileSync(adapter.helper,`import fs from 'node:fs';import{namedGithubCredential}from ${JSON.stringify(pathToFileURL(built).href)};
if(process.argv[3]==='get')try{process.stdout.write(namedGithubCredential(fs.readFileSync(0,'utf8'),process.argv[2],process.env,(args,env)=>{
 if(!args.includes('--no-refresh')||env.GH_DEBUG||['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'].some(k=>env[k]))throw Error('fixture_scope_broken');
 fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({user:process.argv[2],args})+'\\n');return{status:1,stdout:'',stderr:'no oauth token found',error:undefined};}));}catch(e){process.stderr.write((e.code??'fixture_failed')+'\\n');process.exitCode=2;}`);
  for(const[k,v]of Object.entries({HOME:home,USERPROFILE:home,CAVEAT_HOME:caveatHome,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CODEX_HOME:path.join(home,'.codex'),GROK_HOME:path.join(home,'.grok'),CURSOR_HOME:path.join(home,'.cursor'),XDG_STATE_HOME:path.join(home,'state'),LOCALAPPDATA:path.join(home,'state'),GH_CONFIG_DIR:path.join(home,'gh'),GIT_SSL_NO_VERIFY:'true',NO_PROXY:'',no_proxy:'',GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_TERMINAL_PROMPT:'0'}))vi.stubEnv(k,v);
  for(const k of Object.keys(process.env))if(k.toUpperCase().startsWith('GIT_CONFIG'))vi.stubEnv(k,undefined);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:401})));
  const git=(args:string[])=>{const r=spawnSync('git',['-C',own,...args],{encoding:'utf8',timeout:10000,windowsHide:true});expect(r.status,r.stderr).toBe(0);return r.stdout.trim();};
  fs.writeFileSync(path.join(home,'.caveatrc.json'),JSON.stringify({knowledgeRepo:own,githubUser:'fixture-target'}));
  const ctx=buildContext(log,{userHome:home,caveatHome});
  try{await run({root,home,own,caveatHome,marker,forbidden,ctx,git});}
  finally{for(const s of sockets)s.destroy();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>tls.close(()=>r()))]);fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});expect(fs.existsSync(root)).toBe(false);}
}
function initialize(f:{own:string;git:(a:string[])=>string}){f.git(['init','-b','main']);fs.writeFileSync(path.join(f.own,'README.md'),'fixture\n');f.git(['add','.']);f.git(['commit','-m','fixture']);f.git(['remote','add','origin','https://github.com/fixture-owner/fixture-repository.git']);}
function selected(f:{marker:string;forbidden:string}){expect(fs.existsSync(f.marker)).toBe(true);const rows=fs.readFileSync(f.marker,'utf8').trim().split('\n').map(s=>JSON.parse(s));expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.user==='fixture-target'&&r.args.includes('--no-refresh'))).toBe(true);expect(fs.existsSync(f.forbidden)).toBe(false);}
for(const route of ['init','init-existing','sync-init','manual','background','periodic'])it(`reaches the selected helper through real ${route} sync, simple-git and Git`,()=>fixture(async f=>{
 if(route!=='init'&&route!=='sync-init')initialize(f);
 if(route==='init'||route==='init-existing')await expect(runInit(f.ctx,{sync:'https://github.com/fixture-owner/fixture-repository.git',yes:true,skipClaude:true,dryRun:false},{codexAvailable:()=>false,isTty:()=>false})).rejects.toThrow('CAVEAT_GITHUB_USER_UNAVAILABLE');
 else if(route==='sync-init'||route==='manual'){await runSync(f.ctx,route==='sync-init'?{init:'https://github.com/fixture-owner/fixture-repository.git'}:{});expect(log.error.mock.calls.flat().join(' ')).toContain('CAVEAT_GITHUB_USER_UNAVAILABLE');}
 else if(route==='background'){vi.stubEnv('CAVEAT_AUTO_SYNC','on');const halt=new Error('fixture worker exit');const exit=vi.spyOn(process,'exit').mockImplementation(()=>{throw halt;});try{await expect(runHook('autosync')).rejects.toBe(halt);}finally{exit.mockRestore();}expect(readAutoSyncState(f.caveatHome)?.ownSync.consecutiveFailureCount).toBe(1);}
 else{await runAutosync(f.ctx);const r=readPeriodicSyncState(f.caveatHome)?.last_result;expect(r?.status).toBe('failed');expect(r?.reason).toBe('caveat_github_user_unavailable');}
 selected(f);
}),30000);

it('neutralizes user helper/protocol values only in the selected instance',()=>fixture(async f=>{
 initialize(f);const evil=path.join(f.root,'external.mjs');fs.writeFileSync(evil,`import fs from'node:fs';fs.writeFileSync(${JSON.stringify(f.forbidden)},'unexpected');`);
 const quote=(s:string)=>"'"+s.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'";
 const helper=`!${quote(process.execPath)} ${quote(evil)}`;
 for(const key of ['credential.helper','credential.https://github.com/fixture-owner.helper'])f.git(['config',key,helper]);
 f.git(['config','http.https://github.com/fixture-owner.extraHeader','Authorization: Basic fixture-external-not-valid']);
 f.git(['config','protocol.file.allow','always']);f.git(['config','protocol.https.allow','never']);
 const before=fs.readFileSync(path.join(f.own,'.git/config'));const named=createGit(f.own,{githubUser:'fixture-target'});
 expect(await named.raw(['config','--get','protocol.file.allow'])).toBe('never\n');
 await runSync(f.ctx,{});selected(f);expect(fs.readFileSync(path.join(f.own,'.git/config'))).toEqual(before);
 const ordinary=createGit(f.own);await expect(ordinary.raw(['-c','credential.helper=fixture','status'])).rejects.toThrow('allowUnsafeCredentialHelper');
}),30000);

for(const mode of ['count','parameters','files','protocol','trace'])it(`rejects inherited GIT_CONFIG injection: ${mode}`,()=>fixture(async f=>{
 initialize(f);
 if(mode==='count'){vi.stubEnv('GIT_CONFIG_COUNT','2');vi.stubEnv('GIT_CONFIG_KEY_0','credential.helper');vi.stubEnv('GIT_CONFIG_VALUE_0','!exit 83');vi.stubEnv('GIT_CONFIG_KEY_1','protocol.https.allow');vi.stubEnv('GIT_CONFIG_VALUE_1','never');}
 else if(mode==='parameters')vi.stubEnv('GIT_CONFIG_PARAMETERS',"'credential.helper=!exit 83' 'protocol.https.allow=never'");
 else if(mode==='trace'){vi.stubEnv('GIT_TRACE',f.forbidden);vi.stubEnv('GIT_TRACE_CURL',f.forbidden);vi.stubEnv('GIT_CURL_VERBOSE','1');vi.stubEnv('GH_DEBUG','api');}
 else if(mode==='protocol'){vi.stubEnv('GIT_ALLOW_PROTOCOL','file');vi.stubEnv('GIT_PROTOCOL_FROM_USER','1');}
 else{const conf=path.join(f.root,'injected.config');fs.writeFileSync(conf,'[credential]\n helper = !exit 83\n[protocol "https"]\n allow = never\n');for(const k of ['GIT_CONFIG','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM'])vi.stubEnv(k,conf);}
 await runSync(f.ctx,{});
 if(mode==='trace')selected(f);
 else{expect(log.error.mock.calls.flat().join(' ')).toContain('CAVEAT_GIT_ENV_UNSAFE');expect(fs.existsSync(f.marker)).toBe(false);expect(fs.existsSync(f.forbidden)).toBe(false);}
}),30000);
for(const user of ['','bad user','bad\tuser',`bad'quote`,'bad"quote','bad;user','bad\nuser','-bad','bad-','bad--user','fixture-target\n','fixture-target\r','fixture-target\r\n'])it(`rejects invalid named user ${JSON.stringify(user)} before an opted-in Git instance`,()=>{
 expect(()=>createGit(os.tmpdir(),{githubUser:user})).toThrow('CAVEAT_GITHUB_USER_INVALID');
});

it('refuses an unrecognized user helper key before enabling the named instance',()=>fixture(async f=>{
 initialize(f);f.git(['config','credential.https://github.com/fixture path.helper','!exit 83']);
 expect(()=>createGit(f.own,{githubUser:'fixture-target'})).toThrow('CAVEAT_GITHUB_CONFIG_UNSUPPORTED');
 expect(fs.existsSync(f.marker)).toBe(false);expect(fs.existsSync(f.forbidden)).toBe(false);
}),30000);

it('routes the real MCP own sync through simple-git, Git and the named fake credential helper',()=>fixture(async f=>{
  initialize(f);
  const {syncClient}=await import('../../../apps/mcp/tests/fixtures/syncClient.js');
  const mcp=await syncClient({userHome:f.home,caveatHome:f.caveatHome,logger:log});
  try {
    const tools=await mcp.client.listTools();const tool=tools.tools.find(t=>t.name==='caveat_sync');
    expect(tool?.annotations).toMatchObject({openWorldHint:true});expect(tool?.annotations?.readOnlyHint).not.toBe(true);
    const refused=await mcp.client.callTool({name:'caveat_sync',arguments:{repo:'https://forbidden.invalid'}});
    expect(refused.isError).toBe(true);expect(fs.existsSync(f.marker)).toBe(false);
    const result=await mcp.client.callTool({name:'caveat_sync',arguments:{}});
    expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('CAVEAT_GITHUB_USER_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('fixture-repository');selected(f);
    const {readMcpSyncState}=await import('../src/mcpSyncState.js');
    expect(readMcpSyncState(f.caveatHome)).toMatchObject({status:'failed',code:'CAVEAT_GITHUB_USER_UNAVAILABLE'});
  } finally {await mcp.close();}
}),20000);

it('refuses configured askpass instead of broadening named helper opt-ins',()=>fixture(async f=>{
 initialize(f);f.git(['config','core.askPass','fixture-never-invoked']);const before=fs.readFileSync(path.join(f.own,'.git/config'));
 expect(()=>createGit(f.own,{githubUser:'fixture-target'})).toThrow('CAVEAT_GITHUB_CONFIG_UNSUPPORTED');
 expect(fs.existsSync(f.marker)).toBe(false);expect(fs.existsSync(f.forbidden)).toBe(false);expect(fs.readFileSync(path.join(f.own,'.git/config'))).toEqual(before);
}));
