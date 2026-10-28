import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { assessGlobalProcesses } from '../packages/core/dist/managedGlobalProcesses.js';
import { isWindows } from '../packages/core/dist/platform.js';
import { nativeGlobalProcessTables } from '../packages/core/dist/managedProcessNative.js';

// Serial real-table acceptance: reads existing processes and owns only its bounded fixture child.
async function check() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-process-runner-'))), old = join(root, 'old-global');
  mkdirSync(old);
  const scope = { packageRoot: old, npmRoot: join(root, 'npm'), binAliases: [join(root, 'bin/caveat')] };
  const tally = values => { const counts = {}; for (const value of values) counts[value] = (counts[value] ?? 0) + 1; return counts; };
  const proof = (name, result) => {
    process.stdout.write('CAVEAT_PROCESS_RUNNER_PROOF ' + JSON.stringify({ name, status: result.status, confirmedExitedDuringRead: result.confirmedExitedDuringRead, counts: result.counts, errors: result.errors,
      unobservableRuntimes: tally(result.records.filter(row => row.reason === 'foreign_runtime_arguments_unavailable').map(row => row.runtimeKind)),
      unknownReasons: tally(result.records.filter(row => row.classification === 'unknown').map(row => row.reason)),
      metadataByOwner: tally(result.records.map(row => row.observation.owner + ':' + (row.observation.missing.join(',') || 'complete'))),
      nativeIssues: tally(result.records.flatMap(row => row.observation.nativeIssues)),
      filesystemWrites: result.filesystemWrites, existingProcessOperations: result.existingProcessOperations }) + '\n');
  };
  let child;
  try {
    const normal = assessGlobalProcesses(scope, await nativeGlobalProcessTables()); proof('normal-real-table', normal);
    if (isWindows()) {
      assert.equal(normal.status, 'stopped', 'windows_normal_readiness_not_accepted');
      assert.deepEqual(normal.errors, []); assert.equal(normal.consumers, 0); assert.equal(normal.writers, 0);
      const unknown = normal.records.filter(row => row.classification === 'unknown');
      assert.ok(unknown.length > 0, 'windows_typed_refusal_required');
      assert.ok(unknown.every(row => row.observation.nativeIssues.some(issue => /^(?:windows-owner:|windows-metadata:|windows-owner-method:)/.test(issue))), 'windows_unclassified_unknown');
      process.stdout.write('CAVEAT_PROCESS_RUNNER_ACCEPTANCE ' + JSON.stringify({ normal: 'windows-typed-stopped', ready: 'not-accepted', typedRefusals: unknown.length, unclassifiedUnknown: 0 }) + '\n');
    }
    const script = join(old, 'consumer.cjs');
    writeFileSync(script, 'process.send("ready");setInterval(()=>{},1000)');
    child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let timer;
    try {
      await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('consumer_exited_before_ready'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('consumer_ready_deadline')), 5000); })]);
    } finally { clearTimeout(timer); }
    const tables = await nativeGlobalProcessTables(), literal = assessGlobalProcesses(scope, tables); proof('literal-real-consumer', literal);
    assert.equal(literal.status, 'stopped');
    assert.equal(literal.records.find(row => row.pid === child.pid)?.classification, 'consumer');
    const self = tables.before.find(row => row.pid === tables.selfPid);
    assert.equal(tables.before.find(row => row.pid === child.pid)?.uid, self.uid);
    // Fault injection preserves the real PID/birth/owner while withholding native metadata, never changing host access rules.
    for (const table of [tables.before, tables.after]) {
      const row = table.find(value => value.pid === child.pid);
      row.executable = null; row.argv = null;
    }
    const unavailable = assessGlobalProcesses(scope, tables); proof('real-same-owner-child-metadata-fault', unavailable);
    assert.equal(unavailable.status, 'stopped');
    assert.equal(unavailable.records.find(row => row.pid === child.pid)?.classification, 'unknown');
    if (!isWindows()) assert.equal(normal.status, 'ready', 'normal_real_runner_not_ready');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    rmSync(root, { recursive: true, force: true });
  }
}
await check();
