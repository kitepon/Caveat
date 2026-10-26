import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native proof retains its fixture until wrapper descendants close their pipes', t => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-native-close-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const receipt = join(root, 'closed.json');
  const script = fileURLToPath(new URL('./managed-native-hash-proof.mjs', import.meta.url));
  const built = fileURLToPath(new URL('../apps/cli/dist/', import.meta.url));
  const fake = fileURLToPath(new URL('./fixtures/fake-native-close.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, built, fake], { env: { ...process.env, CAVEAT_FAKE_CLOSE_RECEIPT: receipt }, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'ok');
  const closed = JSON.parse(readFileSync(receipt));
  assert.equal(closed.profilePresentUntilClose, true);
  assert.equal(existsSync(closed.root), false);
});


test('native close failure retains a bounded partial receipt without announcing success', async t => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-native-close-failure-'));
  const receipt = join(root, 'closed.json');
  const script = fileURLToPath(new URL('./managed-native-hash-proof.mjs', import.meta.url));
  const built = fileURLToPath(new URL('../apps/cli/dist/', import.meta.url));
  const fake = fileURLToPath(new URL('./fixtures/fake-native-close.js', import.meta.url));
  let fixtureRoot;
  t.after(() => { if(fixtureRoot)rmSync(fixtureRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); });
  const result = spawnSync(process.execPath, [script,built,fake], { env:{...process.env,CAVEAT_FAKE_CLOSE_RECEIPT:receipt,CAVEAT_FAKE_CLOSE_DELAY_MS:'6000'},encoding:'utf8',timeout:60000,maxBuffer:1024*1024 });
  assert.notEqual(result.status,0);assert.equal(result.stdout,'');
  const deadline=Date.now()+12000;
  while(!existsSync(receipt)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  const closed=JSON.parse(readFileSync(receipt));fixtureRoot=closed.root;assert.equal(closed.profilePresentUntilClose,true);assert.equal(existsSync(fixtureRoot),true);
  const saved=JSON.parse(readFileSync(join(fixtureRoot,'failure-receipt.json'),'utf8'));
  assert.equal(saved.status,'failed');assert.equal(saved.stage,'native_close');assert.equal(saved.root,fixtureRoot);assert.equal(saved.closed,false);assert.equal(saved.hookProofCompleted,true);
  assert.equal(saved.modelCalls,0);assert.equal(saved.trustWrites,0);assert.equal(saved.realUserConfigWrites,0);assert.equal(saved.guardMs,3000);
  assert.ok(saved.pid>0);assert.equal(saved.exitCode,0);assert.equal(saved.ownedKillAttempted,false);
  assert.ok(result.stderr.includes('"nativeProofFailure"'));assert.ok(result.stderr.includes(fixtureRoot));
});
