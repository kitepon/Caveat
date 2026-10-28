import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { assessGlobalProcesses, processProtectionTree } from '../packages/core/dist/managedGlobalProcesses.js';
import { snapshotGlobalTree } from '../packages/core/dist/managedGlobalSnapshot.js';
import { isWindows } from '../packages/core/dist/platform.js';
import { checkWindowsResourceUsers } from './check-windows-resource-users.mjs';
import { checkMacProcessRename } from './check-mac-process-rename.mjs';
import { nativeGlobalProcessTables } from '../packages/core/dist/managedProcessNative.js';

// Serial real-table acceptance: reads existing processes and owns only its bounded fixture child.
async function check() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-process-runner-'))), old = join(root, 'old-global');
  mkdirSync(old); mkdirSync(join(root, 'npm')); mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'bin/caveat'), 'fixture alias');
  const scope = { packageRoot: old, npmRoot: join(root, 'npm'), binAliases: [join(root, 'bin/caveat')], runtimeExecutables: [realpathSync(process.execPath)] };
  const libraries = process.report.getReport().sharedObjects.filter(path => /(?:^|[/\\])(?:libnode[^/\\]*|node\.dll)$/i.test(path));
  const snapshot = path => snapshotGlobalTree(path, { observeOnly: true, opaqueExternalLinks: true, maxBytes: 256 * 1024 * 1024 });
  const immutablePaths = [...new Set([scope.npmRoot, ...scope.binAliases, process.execPath, realpathSync(process.execPath), ...libraries])];
  const immutable = immutablePaths.map(path => ({ path, rows: snapshot(path) }));
  const protectionFor = (current = old, original = current) => {
    const expected = snapshot(current);
    return () => {
      for (const row of immutable) assert.deepEqual(snapshot(row.path), row.rows, 'runner_protected_object_changed');
      assert.deepEqual(snapshot(current), expected, 'runner_protected_package_changed');
      const absent = current === original ? [] : [original];
      if (absent.length) assert.throws(() => snapshot(original), { code: 'ENOENT' });
      return { objects: [...immutable.flatMap(row => processProtectionTree(row.path, row.rows.map(row => ({ relativePath: row.relativePath, identity: row })))),
        ...processProtectionTree(current, expected.map(row => ({ relativePath: row.relativePath, identity: row })), original)], absent, postMutation: current !== original };
    };
  };
  const observe = async () => {
    const protection = protectionFor(), before = protection(), tables = await nativeGlobalProcessTables();
    assert.deepEqual(protection(), before); return { tables, protection: before };
  };
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
    if (isWindows()) await checkWindowsResourceUsers(root);
    const initial = await observe(), normal = assessGlobalProcesses(scope, initial.tables, initial.protection); proof('normal-real-table', normal);
    if (initial.tables.before.some(row => row.ownerProof === 'darwin-kinfo-proc')) await checkMacProcessRename(root, scope, nativeGlobalProcessTables, protectionFor);
    const script = join(old, 'consumer.cjs');
    writeFileSync(script, 'process.send("ready");setInterval(()=>{},1000)');
    child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    let timer;
    try {
      await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('consumer_exited_before_ready'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('consumer_ready_deadline')), 5000); })]);
    } finally { clearTimeout(timer); }
    const observed = await observe(), tables = observed.tables, literal = assessGlobalProcesses(scope, tables, observed.protection); proof('literal-real-consumer', literal);
    assert.equal(literal.status, 'stopped');
    assert.equal(literal.records.find(row => row.pid === child.pid)?.classification, 'consumer');
    const self = tables.before.find(row => row.pid === tables.selfPid);
    assert.equal(tables.before.find(row => row.pid === child.pid)?.uid, self.uid);
    // Fault injection preserves the real PID/birth/owner while withholding native metadata, never changing host access rules.
    for (const table of [tables.before, tables.after]) {
      const row = table.find(value => value.pid === child.pid);
      row.executable = null; row.argv = null;
    }
    const unavailable = assessGlobalProcesses(scope, tables, observed.protection); proof('real-same-owner-child-metadata-fault', unavailable);
    assert.equal(unavailable.status, 'stopped');
    assert.equal(unavailable.records.find(row => row.pid === child.pid)?.classification, 'unknown');
    assert.equal(normal.status, 'ready', 'normal_real_runner_not_ready');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
    rmSync(root, { recursive: true, force: true });
  }
}
await check();
