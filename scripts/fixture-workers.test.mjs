import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForFixtureWorkers } from './fixture-workers.mjs';

test('keeps the owned fixture until a detached-style worker finishes its late write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-fixture-worker-'));
  const script = join(root,'worker.cjs');
  writeFileSync(script,`const fs=require('node:fs'),p=require('node:path'),root=process.argv[2];fs.writeFileSync(p.join(root,'ready'),'');setTimeout(()=>{fs.mkdirSync(p.join(root,'index'));fs.writeFileSync(p.join(root,'index','late.db'),'complete');},1000);`);
  const child = spawn(process.execPath, [script, root, 'hook', 'autosync'], { stdio: 'ignore', windowsHide: true });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, 'ready'))) { assert.ok(Date.now() < deadline, 'fixture worker failed to start'); await delay(10); }
    await assert.rejects(waitForFixtureWorkers(root,[fileURLToPath(import.meta.url)]),/cli_script_outside_fixture/);
    assert.equal((await waitForFixtureWorkers(root,[script])).status, 'drained');
    assert.ok(existsSync(join(root, 'index', 'late.db')), 'cleanup returned before the late write');
    await closed;
    rmSync(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
    assert.equal(existsSync(root), false);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
