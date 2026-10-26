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
