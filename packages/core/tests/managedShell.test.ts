import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, realpathSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stageManagedDeployment, activateManagedDeployment, managedDeploymentPaths } from '../src/managedDeployment.js';
import { renderManagedShellWrappers, managedShellPlan, captureManagedShellManifest, managedShellStatus } from '../src/managedShell.js';
import { isWindows } from '../src/platform.js';
import { runWindowsAcl } from '../src/privateWindowsAcl.js';

const windows = isWindows();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-shell-'))); roots.push(root);
  if (windows) runWindowsAcl(root, true, true);
  const userHome = join(root, "profile space ' 日本"); mkdirSync(userHome, { mode: 0o700 });
  const options = { userHome, aclRunner: () => {}, aclTreeRunner: () => {}, aclVerifyTreeRunner: () => {}, aclSourceRunner: () => {} };
  const source = join(root, 'source'); mkdirSync(join(source, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '1.0.0', type: 'module', bin: { caveat: 'dist/caveat.js' } }));
  writeFileSync(join(source, 'dist', 'caveat.js'), "if(process.argv[2]==='stdio'){process.stderr.write(Buffer.from([0,255,10]));process.stdin.pipe(process.stdout);}else{console.log(JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),marker:process.env.CAVEAT_SHELL_TEST}));process.exitCode=37;}\n");
  const built = fileURLToPath(new URL('../../../apps/cli/dist/', import.meta.url));
  for (const [src,dst] of [['stable-entry.mjs','stable-entry.mjs'],['managed-deployment.js','managed-deployment.js']]) writeFileSync(join(source, 'dist', dst), readFileSync(join(built, src)));
  const staged = stageManagedDeployment(source, options);activateManagedDeployment(staged.release, options);
  const paths = managedDeploymentPaths(userHome);if(windows)runWindowsAcl(paths.root,true,true);
  const binDir = join(root, 'bin space 日本');mkdirSync(binDir, { mode: 0o700 });
  const plan = managedShellPlan(process.execPath, binDir, options);
  const protectedFiles = [paths.launcher, paths.runtime, paths.pointer];
  for (let n=0;n<11;n++) {const file=join(userHome,'protected-'+n);writeFileSync(file,'unchanged-'+n,{mode:0o600});protectedFiles.push(file);}
  const initial = protectedFiles.map(hash);
  const install = () => {for (const file of plan.files) writeFileSync(file.path, file.content, { mode: 0o755, flag: 'wx' });};
  const save = () => {const manifest=captureManagedShellManifest(plan);mkdirSync(join(paths.root,'shell'),{mode:0o700});writeFileSync(join(paths.root,'shell/manifest.json'),JSON.stringify(manifest),{mode:0o600});return manifest;};
  return { root, userHome, options, paths, plan, install, save, assertProtected: () => expect(protectedFiles.map(hash)).toEqual(initial) };
}

it('shell plan rejects relative nodes and shell-interpreted Windows path literals', () => {
  for (const node of ['node','../node','/node\ncommand']) expect(()=>renderManagedShellWrappers(node,'/entry',false)).toThrow();
  for (const node of ['C:\\日本\\node.exe','node.exe','C:\\%NODE%\\node.exe','C:\\x&y\\node.exe','C:\\x"y\\node.exe']) expect(()=>renderManagedShellWrappers(node,'C:\\entry.mjs',true)).toThrow();
  const f=fixture();expect(()=>managedShellPlan(process.execPath,'relative',f.options)).toThrow('absolute_bin_required');expect(managedShellStatus(f.options).status).toBe('not-installed');f.assertProtected();
},60000);
it('owned shell manifest is ready without rewriting protected registrations, entry, pointer or trust', () => {
  const f=fixture();f.install();const manifest=f.save();expect(managedShellStatus(f.options).status).toBe('ready');
  const reversed=Object.fromEntries(Object.entries(manifest).reverse());writeFileSync(join(f.paths.root,'shell/manifest.json'),JSON.stringify(reversed));expect(managedShellStatus(f.options).status).toBe('ready');f.assertProtected();
},60000);
it('package-manager overwrite is diagnosed and original leaf can be restored exactly', () => {
  const f=fixture();f.install();f.save();const file=f.plan.files[0]!.path,backup=file+'.original';renameSync(file,backup);writeFileSync(file,'foreign npm/brew wrapper',{mode:0o755});
  expect(managedShellStatus(f.options)).toMatchObject({status:'changed',reason:'managed_shell_wrapper_bytes_changed'});expect(readFileSync(file,'utf8')).toBe('foreign npm/brew wrapper');
  rmSync(file);renameSync(backup,file);expect(managedShellStatus(f.options).status).toBe('ready');f.assertProtected();
},60000);
it('missing or redirected shell leaves are refused without repairing them', () => {
  const f=fixture();f.install();f.save();const file=f.plan.files[0]!.path;rmSync(file);expect(managedShellStatus(f.options)).toMatchObject({status:'changed',reason:'wrapper_missing'});expect(existsSync(file)).toBe(false);
  mkdirSync(file);expect(managedShellStatus(f.options)).toMatchObject({status:'changed',reason:'managed_shell_redirect_or_nonregular'});f.assertProtected();
},60000);
it('unknown manifest, changed ownership and changed entry are separate from payload health', () => {
  const f=fixture();f.install();const manifest=f.save(),file=join(f.paths.root,'shell/manifest.json');writeFileSync(file,'{');expect(managedShellStatus(f.options).status).toBe('unknown');
  const foreign=structuredClone(manifest);if(windows)foreign.files[0]!.native!.owner='S-1-5-21-unknown';else foreign.files[0]!.identity.uid+=1;
  writeFileSync(file,JSON.stringify(foreign));expect(managedShellStatus(f.options)).toMatchObject({status:'changed',reason:'ownership_or_identity_changed'});
  writeFileSync(file,JSON.stringify(manifest));const entry=readFileSync(f.paths.launcher);writeFileSync(f.paths.launcher,'changed entry');expect(managedShellStatus(f.options)).toMatchObject({status:'changed',reason:'entry_changed'});writeFileSync(f.paths.launcher,entry);const runtime=readFileSync(f.paths.runtime);writeFileSync(f.paths.runtime,'changed runtime');expect(managedShellStatus(f.options)).toMatchObject({status:'changed',reason:'entry_changed'});writeFileSync(f.paths.runtime,runtime);f.assertProtected();
},60000);
it('capture refuses modified plans and wrapper contents instead of claiming unknown files', () => {
  const f=fixture();f.install();mkdirSync(join(f.paths.root,'shell'),{mode:0o700});expect(managedShellStatus(f.options)).toMatchObject({status:'changed',reason:'ownership_manifest_missing'});const bad=structuredClone(f.plan);bad.files[0]!.path=join(f.root,'outside');expect(()=>captureManagedShellManifest(bad)).toThrow();
  writeFileSync(f.plan.files[0]!.path,'unknown');expect(()=>captureManagedShellManifest(f.plan)).toThrow('wrapper_bytes_changed');f.assertProtected();
},60000);

function invoke(file: string, args: string[], cwd: string, input?: Buffer) {
  const options = { cwd, input, env:{...process.env,CAVEAT_SHELL_TEST:'inherited value 日本'}, timeout:30000, maxBuffer:1024*1024, windowsHide:true };
  if(!windows)return spawnSync(file,args,options);
  const psQuote=(v:string)=>"'"+v.replaceAll("'","''")+"'";
  if(file.endsWith('.ps1')){
    const command='& '+psQuote(file)+' '+args.map(psQuote).join(' ')+'; exit $LASTEXITCODE';
    return spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],options);
  }
  if(file.endsWith('.cmd')){
    const quote=(v:string)=>'"'+v.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/g,'$1$1')+'"';
    return spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c','"'+[file,...args].map(quote).join(' ')+'"'],{...options,windowsVerbatimArguments:true});
  }
  const bash=['C:/Program Files/Git/bin/bash.exe','C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync);expect(bash,'Git Bash required for the extensionless Windows shim').toBeTruthy();
  // MSYS has a different native argv parser; use a real POSIX caller so it cannot pre-mangle apostrophes.
  const quote=(v:string)=>"'"+v.replaceAll("'","'\\''")+"'";
  const caller=join(cwd,'fixture-posix-caller.sh');writeFileSync(caller,'#!/bin/sh\nexec '+[file.replaceAll('\\','/'),...args].map(quote).join(' ')+'\n');
  return spawnSync(bash!,[caller.replaceAll('\\','/')],options);
}
it('real wrapper processes preserve argv, working directory, environment and exit status', () => {
  const f=fixture();f.install();const args=['','space value','quote"value','single\'quote','trailing\\','日本語','--leading','semi;colon','5%'];
  for(const file of f.plan.files){const r=invoke(file.path,['argv',...args],f.root);expect(r.error).toBeUndefined();expect(r.status, file.name+': '+String(r.stderr)).toBe(37);expect(JSON.parse(String(r.stdout)),file.name).toEqual({args,cwd:f.root,marker:'inherited value 日本'});}
  if(windows){const ps1=f.plan.files.find(f=>f.name.endsWith('.ps1'))!.path;const q=(v:string)=>"'"+v.replaceAll("'","''")+"'";const source='& '+q(ps1)+' '+['argv',...args].map(q).join(' ')+'; exit $LASTEXITCODE';const r=spawnSync(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')],{cwd:f.root,env:{...process.env,CAVEAT_SHELL_TEST:'inherited value 日本'},timeout:30000});expect(r.error,'Windows PowerShell 5.1 absolute OS entry').toBeUndefined();expect(r.status,String(r.stderr)).toBe(37);expect(JSON.parse(String(r.stdout)).args).toEqual(args);}
  f.assertProtected();
},90000);
it('real wrappers preserve binary stdin/stdout/stderr without PowerShell pipeline decoding', () => {
  const f=fixture();f.install();const input=Buffer.from([0,1,10,13,34,128,255,65]);
  for(const file of f.plan.files){const r=invoke(file.path,['stdio'],f.root,input);expect(r.error).toBeUndefined();expect(r.status,String(r.stderr)).toBe(0);expect(r.stdout).toEqual(input);expect(r.stderr).toEqual(Buffer.from([0,255,10]));}
  f.assertProtected();
},90000);

it('built deployment CLI returns read-only plans and independent shell diagnostics', () => {
  const f=fixture(),cli=fileURLToPath(new URL('../../../apps/cli/dist/caveat.js',import.meta.url));
  const env={...process.env,HOME:f.userHome,USERPROFILE:f.userHome};
  const run=(...args:string[])=>{const r=spawnSync(process.execPath,[cli,'deployment',...args,'--json'],{env,encoding:'utf8',timeout:60000});expect(r.status,String(r.stderr)).toBe(0);return JSON.parse(r.stdout);};
  const planned=run('shell-plan','--node',process.execPath,'--bin-dir',f.plan.binDir);expect(planned.files.map((f:{name:string})=>f.name)).toEqual(f.plan.files.map(f=>f.name));
  expect(run('status').shell.status).toBe('not-installed');f.install();
  const manifest=run('shell-manifest','--node',process.execPath,'--bin-dir',f.plan.binDir);mkdirSync(join(f.paths.root,'shell'),{mode:0o700});writeFileSync(join(f.paths.root,'shell/manifest.json'),JSON.stringify(manifest),{mode:0o600});
  expect(run('status')).toMatchObject({status:'ready',payloadVerified:true,shell:{status:'ready'}});
  writeFileSync(f.plan.files[0]!.path,'foreign wrapper');expect(run('status')).toMatchObject({status:'ready',payloadVerified:true,shell:{status:'changed'}});f.assertProtected();
},240000);
