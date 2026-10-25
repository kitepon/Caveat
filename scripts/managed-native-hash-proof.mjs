#!/usr/bin/env node
// Explicit acceptance harness: isolated fixture profile and read-only Codex RPC.
// No thread/model calls, hook execution, trust writes, or real-user config edits.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { commandInvocation } from './process-command.mjs';
import { isWindows } from '../packages/core/dist/platform.js';

const built = resolve(process.argv[2] ?? 'apps/cli/dist');
const search = [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), join(homedir(), 'AppData/Roaming/npm'), '/opt/homebrew/bin', '/usr/local/bin'];
// npm installs both a POSIX text shim and a .cmd shim on Windows. The
// extensionless file exists but CreateProcess cannot execute it.
const executableNames = isWindows() ? ['codex.exe', 'codex.cmd'] : ['codex'];
const executable = process.argv[3] ?? search.flatMap(dir => executableNames.map(name => join(dir, name))).find(path => existsSync(path));
assert.ok(executable, 'Codex CLI is required for native hook-hash acceptance; no model or authentication is used');
const { stageManagedDeployment, activateManagedDeployment, managedDeploymentPaths } = await import(new URL('../packages/core/dist/managedDeployment.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'caveat-native-entry-'));
const userHome = join(root, 'profile'); mkdirSync(userHome, { mode: 0o700 });
const codexHome = join(userHome, '.codex'); mkdirSync(codexHome, { mode: 0o700 });
let child, lines, timer, nativeStderr = '', complete = false;
const pending = new Map(); let sequence = 0;
try {
  function source(version) {
    const dir = join(root, version); mkdirSync(join(dir, 'dist'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'caveat-cli', version, type: 'module', bin: { caveat: 'dist/caveat.js' } }));
    writeFileSync(join(dir, 'dist', 'caveat.js'), '// not executed by this hash proof\n');
    for (const name of ['stable-entry.mjs', 'managed-deployment.js']) writeFileSync(join(dir, 'dist', name), readFileSync(join(built, name)));
    return dir;
  }
  const a = stageManagedDeployment(source('1.0.0'), { userHome });
  const b = stageManagedDeployment(source('1.0.1'), { userHome });
  const paths = managedDeploymentPaths(userHome);
  const quote = p => /[\s\\]/.test(p) ? `"${p}"` : p;
  const hooks = {};
  for (const [name,event] of [['UserPromptSubmit','user-prompt-submit'],['PostToolUse','post-tool-use'],['Stop','stop']]) {
    // commandWindows is deliberately absent; the exact same fixture command is listed in each phase.
    hooks[name] = [{ hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(paths.launcher)} codex-hook ${event}`, timeout: 5, async: false }] }];
  }
  writeFileSync(join(codexHome, 'config.toml'), '[features]\nhooks = true\n', { mode: 0o600 });
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks }), { mode: 0o600 });
  const invocation=commandInvocation(executable.endsWith('.js') ? process.execPath : executable,[...(executable.endsWith('.js') ? [executable] : []),'app-server']);
  child = spawn(invocation.command, invocation.args, { env: { ...process.env, CODEX_HOME: codexHome }, cwd: userHome, stdio: ['pipe','pipe','pipe'], windowsHide: true, detached: !isWindows() });
  child.stderr.on('data', bytes => { nativeStderr = (nativeStderr + bytes.toString()).slice(-4000); });
  lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const x = JSON.parse(line), p = pending.get(x.id); if (!p) return; pending.delete(x.id); x.error ? p.reject(Error(`native_rpc_${x.error.code}`)) : p.resolve(x.result); } catch {} });
  child.on('error', error => { for (const p of pending.values()) p.reject(Error(`native_unavailable:${error.code ?? error.message}`)); });
  child.on('exit', (code, signal) => { for (const p of pending.values()) p.reject(Error(`native_exited:code=${code}:signal=${signal ?? 'none'}`)); });
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id,{resolve,reject}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); });
  timer = setTimeout(() => { for (const p of pending.values()) p.reject(Error('native_timeout')); }, 30000);
  await request('initialize', { clientInfo: { name: 'caveat-isolated-entry-hash-proof', version: '1' }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
  const phases = [];
  for (const release of [a.release,b.release,a.release]) {
    activateManagedDeployment(release,{userHome});
    const result = await request('hooks/list',{cwds:[userHome]});
    const rows = result.data.flatMap(g=>g.hooks).filter(h=>h.command?.includes(paths.launcher)).map(h=>({key:h.key,event:h.eventName,currentHash:h.currentHash,trust:h.trustStatus,enabled:h.enabled})).sort((a,b)=>a.key.localeCompare(b.key));
    assert.equal(rows.length,3);
    assert.ok(rows.every(h=>h.trust==='untrusted'&&h.enabled));
    phases.push({release,rows});
  }
  assert.deepEqual(phases[1].rows,phases[0].rows); assert.deepEqual(phases[2].rows,phases[0].rows);
  complete = true;
  console.log(JSON.stringify({status:'ok',fixtureProfile:true,phases,hookDefinitionsUnchanged:true,methods:['initialize','hooks/list'],trustWrites:0,modelCalls:0,realUserConfigWrites:0},null,2));
} finally {
  if (!complete && nativeStderr) process.stderr.write(`[native proof stderr] ${nativeStderr}\n`);
  clearTimeout(timer); lines?.close(); child?.stdin.end();
  const alive = () => child && child.exitCode === null && child.signalCode === null;
  const waitClose = async () => { if (alive()) await new Promise(resolve => {
    const timeout = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timeout); resolve(); });
  }); };
  // EOF normally closes the private server and its npm shim. Do not orphan a
  // Windows PowerShell/.cmd descendant by killing only the wrapper first.
  await waitClose();
  if (alive()) {
    if (isWindows()) spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:5000});
    else process.kill(-child.pid, 'SIGTERM');
    await waitClose();
  }
  assert.ok(!alive(), 'owned native proof server did not terminate');
  // Only the owned fixture tree is removed; no real Codex data is read or copied.
  rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
