import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { assessGlobalProcesses } from '../packages/core/dist/managedGlobalProcesses.js';
import { nativeGlobalProcessTables } from '../packages/core/dist/managedProcessNative.js';

// Each real runner owns only its fixture child; existing applications are read only.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-process-runner-'))), old = join(root, 'old-global');
mkdirSync(old);
const scope = { packageRoot: old, npmRoot: join(root, 'npm'), binAliases: [] };
const observe = async name => {
  const result = assessGlobalProcesses(scope, await nativeGlobalProcessTables());
  process.stdout.write('CAVEAT_PROCESS_RUNNER_PROOF ' + JSON.stringify({ name, ...result }) + '\n');
  return result;
};
let child, timer;
try {
  assert.equal((await observe('normal-real-table')).status, 'ready');
  const script = join(old, 'consumer.cjs');
  writeFileSync(script, 'process.on("message",()=>process.exit(0));process.send("ready");setInterval(()=>{},1000)');
  child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('consumer_exited_before_ready'); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('consumer_ready_deadline')), 5000); })]);
  clearTimeout(timer);
  const literal = await observe('literal-real-consumer');
  assert.equal(literal.status, 'stopped');
  const row = literal.records.find(row => row.pid === child.pid);
  assert.equal(row?.classification, 'consumer'); assert.equal(row.parentPid, process.pid);
  assert.notEqual(row.parentApp, 'unavailable'); assert.match(row.resolution.instruction, /close/i);
  const closed = once(child, 'close'); child.send('close'); await closed;
  assert.equal((await observe('closed-real-consumer')).status, 'ready');
} finally {
  clearTimeout(timer);
  if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  rmSync(root, { recursive: true, force: true });
}
