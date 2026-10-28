import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessGlobalProcesses } from '../packages/core/dist/managedGlobalProcesses.js';

/** Owns only a disposable executable and child; existing host processes remain untouched. */
export async function checkMacProcessRename(root, baseScope, collect, protectionFor) {
  const original = join(root, 'rename-image'), quarantine = join(root, 'retained-image');
  mkdirSync(original);
  const source = join(original, 'fixture.c'), executable = join(original, 'fixture');
  writeFileSync(source, '#include <unistd.h>\nint main(void) { if(write(1,"ready\\n",6)!=6) return 1; for(;;) pause(); }\n');
  const compiled = spawnSync('/usr/bin/clang', [source, '-o', executable], { stdio: 'ignore', timeout: 20000 });
  assert.ifError(compiled.error); assert.equal(compiled.status, 0, 'mac_rename_fixture_compile_failed');
  const originalProof = protectionFor(original)();
  const child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'ignore'] });
  let timer;
  try {
    await Promise.race([once(child.stdout, 'data').then(([value]) => assert.equal(value.toString(), 'ready\n')),
      once(child, 'exit').then(() => { throw Error('mac_rename_fixture_exited'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('mac_rename_fixture_ready_deadline')), 5000); })]);
    clearTimeout(timer);
    renameSync(original, quarantine);
    const observe = protectionFor(quarantine, original), confirmed = observe();
    assert.deepEqual(confirmed.objects.filter(row => row.originalPath.startsWith(original + '/') || row.originalPath === original), originalProof.objects.filter(row => row.path.startsWith(original + '/') || row.path === original).map(row => ({ ...row, path: row.path.replace(original, quarantine) })));
    const tables = await collect(); assert.deepEqual(observe(), confirmed);
    const scope = { ...baseScope, packageRoot: original, binAliases: [], retainedRoots: [quarantine] };
    const row = tables.before.find(row => row.pid === child.pid), after = tables.after.find(row => row.pid === child.pid);
    assert.equal(row?.executable?.path, join(quarantine, 'fixture'), 'mac_renamed_kernel_image_not_resolved');
    assert.deepEqual(after?.executable, row.executable);
    const result = assessGlobalProcesses(scope, tables, confirmed), consumer = result.records.find(row => row.pid === child.pid);
    assert.equal(consumer?.classification, 'consumer'); assert.equal(consumer.reason, 'bound_scope_executable_or_script');
    process.stdout.write('CAVEAT_MAC_RENAME_PROOF ' + JSON.stringify({ kernelPathAfterRename: true, boundConsumer: true, status: result.status, ownedChildOnly: true, existingProcessOperations: 0 }) + '\n');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  }
}
