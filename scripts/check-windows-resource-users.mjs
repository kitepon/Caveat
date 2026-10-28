import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { nativeWindowsResourceUsers } from '../packages/core/dist/managedWindowsResourceNative.js';
import { windowsSystemPath } from '../packages/core/dist/platform.js';

/** Qualifies the object reader only; it does not bypass the product process guard. */
export async function checkWindowsResourceUsers(root) {
  const file = join(root, 'resource-観測.js'); writeFileSync(file, 'fixture bytes');
  const record = (name, result) => process.stdout.write('CAVEAT_WINDOWS_RESOURCE_PROOF ' + JSON.stringify({ name, stage: result.stage, code: result.code, endCode: result.endCode,
    observerAdministrator: result.observerAdministrator, regularFiles: result.regularFiles, directories: result.directories, users: result.users.length, services: result.users.filter(row => row.service).length,
    critical: result.users.filter(row => row.type === 1000).length, rebootReasons: result.rebootReasons, existingProcessOperations: 0 }) + '\n');
  const query = async name => {
    const result = await nativeWindowsResourceUsers([file]); record(name, result);
    return result;
  };
  const normal = await query('normal-resource');
  const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");process.send("ready");process.on("message",()=>{fs.closeSync(fd);process.exit(0)})', file], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  let timer;
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('resource_holder_exited'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('resource_holder_ready_deadline')), 5000); })]);
    clearTimeout(timer);
    const held = await query('real-file-holder');
    const closed = once(child, 'close'); child.send('close');
    await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('resource_holder_close_deadline')), 5000); })]); clearTimeout(timer);
    assert.equal(child.exitCode, 0); const released = await query('holder-closed');
    const system = await nativeWindowsResourceUsers([windowsSystemPath('kernel32.dll')]); record('existing-system-module-users', system);
    const detected = held.users.some(row => row.pid === child.pid) && released.stage === 'complete' && released.users.length === 0;
    process.stdout.write('CAVEAT_WINDOWS_RESOURCE_COVERAGE ' + JSON.stringify({ ordinaryObserver: !normal.observerAdministrator, sameOwnerFixture: detected ? 'detected-and-released' : 'not-proven', serviceUsers: system.users.filter(row => row.service).length,
      foreignUid: 'not-proven', sameUidElevated: 'not-proven', productReadiness: 'not-qualified', hostChanges: 0 }) + '\n');
    for (const result of [normal, held, released]) {
      assert.equal(result.regularFiles, 1); assert.equal(result.directories, 0);
      assert.equal(result.stage, 'complete'); assert.equal(result.code, 0); assert.equal(result.endCode, 0);
    }
    assert.equal(normal.users.length, 0); assert.ok(detected, 'resource_holder_not_detected_and_released');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  }
}
