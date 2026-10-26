import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recordCandidate, verifyCandidate, verifyCandidateRun } from './release-artifact.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'caveat-release-artifact-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const context = { source: 'a'.repeat(40), tree: 'b'.repeat(40), version: '0.21.6', repository: 'example/Caveat', runId: '123', attempt: 1 };
  const archive = path.join(directory, 'caveat-cli-0.21.6.tgz');
  writeFileSync(archive, 'one immutable acceptance archive');
  const record = recordCandidate(directory, context, { node: 'v24.21.0', npm: '11.19.1', pnpm: '10.0.0' });
  const expected = { ...context, sha256: record.sha256 };
  const run = { id: 123, run_attempt: 1, repository: { full_name: context.repository }, head_repository: { full_name: context.repository },
    path: '.github/workflows/pack-release.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: context.source, status: 'completed', conclusion: 'success' };
  return { directory, archive, record, expected, run };
}

test('accepted bytes are returned unchanged without invoking a package manager', t => {
  const f = fixture(t);
  const before = readFileSync(f.archive);
  assert.equal(verifyCandidate(f.directory, f.expected, f.run), f.archive);
  assert.deepEqual(readFileSync(f.archive), before);
  assert.throws(() => recordCandidate(f.directory, f.expected, {}), /EEXIST/);
});
test('a repack that changes only manifest ordering still fails the accepted digest', t => {
  const f = fixture(t);
  writeFileSync(f.archive, 'a different but semantically equal archive');
  assert.throws(() => verifyCandidate(f.directory, f.expected, f.run), /AssertionError/);
});
test('a changed digest and matching forged record cannot replace the approved digest', t => {
  const f = fixture(t);
  const record = { ...f.record, sha256: '0'.repeat(64) };
  writeFileSync(path.join(f.directory, 'release-artifact.json'), JSON.stringify(record));
  assert.throws(() => verifyCandidate(f.directory, f.expected, f.run), /sha256/);
});
for (const [key, value] of [['source', 'c'.repeat(40)], ['tree', 'c'.repeat(40)], ['version', '9.9.9'], ['runId', '124'], ['attempt', 2], ['repository', 'attacker/Caveat']]) {
  test(`artifact provenance rejects a different ${key}`, t => {
    const f = fixture(t);
    writeFileSync(path.join(f.directory, 'release-artifact.json'), JSON.stringify({ ...f.record, [key]: value }));
    assert.throws(() => verifyCandidate(f.directory, f.expected, f.run));
  });
}
for (const [key, value] of [['head_sha', 'c'.repeat(40)], ['head_branch', 'topic'], ['path', '.github/workflows/other.yml'], ['event', 'pull_request'], ['status', 'in_progress'], ['conclusion', 'failure'], ['run_attempt', 2]]) {
  test(`API provenance rejects a different ${key} before artifact download`, t => {
    const f = fixture(t);
    assert.throws(() => verifyCandidateRun({ ...f.run, [key]: value }, f.expected));
  });
}
test('fork provenance and malformed identifiers are refused', t => {
  const f = fixture(t);
  assert.throws(() => verifyCandidateRun({ ...f.run, head_repository: { full_name: 'attacker/Caveat' } }, f.expected));
  for (const runId of ['--help', '123/../../456', '123\n']) assert.throws(() => verifyCandidateRun(f.run, { ...f.expected, runId }));
  assert.throws(() => verifyCandidate(f.directory, { ...f.expected, sha256: 'missing' }, f.run));
});
test('unexpected artifact files are refused', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.directory, 'unexpected.tgz'), 'other');
  assert.throws(() => verifyCandidate(f.directory, f.expected, f.run));
});
