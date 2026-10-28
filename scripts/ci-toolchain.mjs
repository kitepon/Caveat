import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const semver = createRequire(new URL('../packages/core/package.json', import.meta.url))('semver');
import { spawnCommandSync } from './process-command.mjs';

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export const contract = readJson('../.github/ci-toolchain.json');
const root = readJson('../package.json');
const cli = readJson('../apps/cli/package.json');

function parts(version) {
  assert.match(version, /^v?\d+\.\d+\.\d+$/, 'CI requires a recorded stable full Node version');
  return version.replace(/^v/, '').split('.').map(Number);
}
function compare(left, right) {
  const a = parts(left), b = parts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
export function assertNodeAllowed(version) {
  parts(version);
  const affected = contract.knownAffected.find(range => compare(version, range.from) >= 0 && compare(version, range.before) < 0);
  assert.ok(!affected, `Known affected Node ${version}: ${affected?.reason}; ${affected?.source}`);
  for (const engine of [root.engines.node, cli.engines.node]) assert.ok(semver.satisfies(version, engine), `Node ${version} does not satisfy engines ${engine}`);

}
export function assertHostedToolchain(node, pnpm) {
  assertNodeAllowed(node);
  assert.equal(node.replace(/^v/, ''), contract.node, 'Hosted Node must match CI toolchain contract');
  assert.equal(root.packageManager, `pnpm@${contract.pnpm}`);
  assert.equal(pnpm, contract.pnpm, 'Hosted pnpm must match CI toolchain contract');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  assert.ok(['hosted', 'native', 'version'].includes(mode));
  assertNodeAllowed(process.version);
  const proof = { node: process.version, execPath: process.execPath, sqlite: process.versions.sqlite };
  if (mode === 'hosted') {
    const result = spawnCommandSync('corepack', ['pnpm', '--version'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, 'Cannot read job pnpm version');
    proof.pnpm = result.stdout.trim();
    assertHostedToolchain(process.version, proof.pnpm);
  }
  if (mode === 'native') {
    const { assertSqliteSearchCapability } = await import('../packages/core/dist/runtimeCapabilities.js');
    Object.assign(proof, assertSqliteSearchCapability());
  }
  console.log(JSON.stringify({ ciToolchain: mode, ...proof }));
}
