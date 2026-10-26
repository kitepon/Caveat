import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const home = process.env.CODEX_HOME, receipt = process.env.CAVEAT_FAKE_CLOSE_RECEIPT;
assert.ok(home && receipt && basename(dirname(home)) === 'profile' && basename(dirname(dirname(home))).startsWith('caveat-native-entry-'));
assert.equal(readFileSync(join(home,'config.toml'),'utf8'),'[features]\nhooks = true\nplugins = false\nremote_plugin = false\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if(process.env.CAVEAT_FAKE_RPC_ERROR==='1'&&request.method==='initialize'){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32099,message:'fixture-only'}})+'\n');return;}
  let result;
  if (request.method === 'initialize') result = { capabilities: {} };
  else {
    assert.equal(request.method, 'hooks/list');
    const config = JSON.parse(readFileSync(join(home, 'hooks.json')));
    result = { data: [{ hooks: Object.entries(config.hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.map(hook => ({
      key: event, eventName: event, command: hook.command, currentHash: createHash('sha256').update(hook.command).digest('hex'), trustStatus: 'untrusted', enabled: true,
    })))) }] };
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
});
process.stdin.once('end', () => {
  // The wrapper exits first; its descendant retains the fixture cwd and pipes.
  const delay=Number(process.env.CAVEAT_FAKE_CLOSE_DELAY_MS??400);assert.ok(Number.isSafeInteger(delay)&&delay>=0&&delay<=10000);
  const code = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.argv[1],JSON.stringify({profilePresentUntilClose:fs.existsSync(process.argv[2]),root:process.argv[3]})),Number(process.argv[4]));`;
  const descendant = spawn(process.execPath, ['-e', code, receipt, join(home, 'hooks.json'), dirname(dirname(home)),String(delay)], { cwd: dirname(home), stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });
  descendant.once('spawn', () => { descendant.unref(); process.exit(0); });
});
