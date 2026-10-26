import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function identity(value) {
  for (const key of ['version', 'source', 'tree', 'repository', 'runId']) assert.equal(value[key], value[key].trim());
  assert.match(value.version, /^\d+\.\d+\.\d+$/);
  for (const key of ['source', 'tree']) assert.match(value[key], /^[a-f0-9]{40}$/);
  assert.match(value.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.match(value.runId, /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(value.attempt) && value.attempt > 0);
  return `caveat-cli-${value.version}.tgz`;
}
function readRegular(file, limit) {
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit, 'invalid artifact file');
  return readFileSync(file);
}
export function recordCandidate(directory, context, tools) {
  const archive = identity(context);
  const bytes = readRegular(path.join(directory, archive), 64 * 1024 * 1024);
  const record = { schema: 1, ...context, archive, sha256: sha(bytes), bytes: bytes.length, tools };
  writeFileSync(path.join(directory, 'release-artifact.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record;
}
export function verifyCandidateRun(run, expected) {
  identity(expected);
  assert.equal(String(run.id), expected.runId);
  assert.equal(run.run_attempt, expected.attempt);
  assert.equal(run.repository.full_name, expected.repository);
  assert.equal(run.head_repository.full_name, expected.repository);
  assert.equal(run.path, '.github/workflows/pack-release.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, expected.source);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
}
export function verifyCandidate(directory, expected, run) {
  const archive = identity(expected);
  assert.match(expected.sha256, /^[a-f0-9]{64}$/);
  verifyCandidateRun(run, expected);
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
  assert.deepEqual(readdirSync(directory).sort(), [archive, 'release-artifact.json'].sort());
  const record = JSON.parse(readRegular(path.join(directory, 'release-artifact.json'), 64 * 1024));
  assert.equal(record.schema, 1);
  for (const key of ['source', 'tree', 'version', 'repository', 'runId', 'attempt', 'sha256']) assert.equal(record[key], expected[key], key);
  assert.equal(record.archive, archive);
  const bytes = readRegular(path.join(directory, archive), 64 * 1024 * 1024);
  assert.equal(bytes.length, record.bytes);
  assert.equal(sha(bytes), expected.sha256, 'archive bytes differ from accepted artifact');
  return path.resolve(directory, archive);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, runFile] = process.argv.slice(2);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const context = { source: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    version: JSON.parse(readFileSync('apps/cli/package.json')).version, repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.CANDIDATE_RUN_ID ?? process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.CANDIDATE_RUN_ATTEMPT ?? process.env.GITHUB_RUN_ATTEMPT) };
  if (mode === 'record') {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
    console.log(JSON.stringify(recordCandidate(directory, context, { node: process.version, npm: process.env.RELEASE_NPM_VERSION, pnpm: process.env.RELEASE_PNPM_VERSION }), null, 2));
  } else if (mode === 'check-run') {
    verifyCandidateRun(JSON.parse(readRegular(directory, 2 * 1024 * 1024)), context);
  } else {
    assert.equal(mode, 'verify');
    console.log(verifyCandidate(directory, { ...context, sha256: process.env.ACCEPTED_ARCHIVE_SHA256 }, JSON.parse(readRegular(runFile, 2 * 1024 * 1024))));
  }
}
