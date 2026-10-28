import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

export async function isolatedPackSmoke(entries, root, version) {
  const packageRoot = join(root, 'isolated', 'package');
  for (const [name, entry] of entries) {
    assert.ok(name.startsWith('package/'));
    const file = resolve(packageRoot, name.slice(8));
    assert.ok(file.startsWith(packageRoot + sep));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.data, { mode: entry.mode });
  }
  const cli = join(packageRoot, 'dist', 'caveat.js');
  const env = { ...process.env, NODE_PATH: '', CAVEAT_HOME: join(root, 'isolated-home'), CAVEAT_AUTO_SYNC: 'off' };
  const result = spawnSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'mcp-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '', initialized = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('isolated MCP initialize timeout')); }, 30000);
    child.stderr.on('data', b => { error += b; });
    child.stdout.on('data', b => {
      output += b;
      const lines = output.split('\n'); output = lines.pop();
      for (const line of lines) {
        try { const r = JSON.parse(line); if (r.id === 1) { assert.ok(r.result?.serverInfo); initialized = true; child.stdin.end(); } }
        catch (e) { clearTimeout(timer); child.kill(); reject(e); }
      }
    });
    child.stdin.on('error', e => { clearTimeout(timer); child.kill(); reject(e); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); initialized && code === 0 ? resolve() : reject(new Error(`isolated MCP failed: ${code}; ${error}`)); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'isolated-pack-smoke', version: '1' } } }) + '\n');
  });
}
