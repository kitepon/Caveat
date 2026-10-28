import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { assertHostedToolchain, assertNodeAllowed, contract } from './ci-toolchain.mjs';

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const yaml = requireFromCore('js-yaml');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = name => yaml.load(read(`../.github/workflows/${name}`), { schema: yaml.JSON_SCHEMA });

export function assertWorkflowPins(doc, pack, publish) {
  for (const steps of [doc.jobs.classify.steps, pack.jobs.pack.steps, publish.jobs.publish.steps]) {
    const setup = steps.filter(step => step.uses?.startsWith('actions/setup-node@'));
    assert.equal(setup.length, 1);
    assert.equal(setup[0].with['node-version'], contract.node);
    assert.ok(steps.some(step => step.run?.includes('node scripts/ci-toolchain.mjs hosted')));
  }
}

test('Hosted doc/pack/publish share full Node and packageManager pnpm pins', () => {
  assert.match(contract.node, /^\d+\.\d+\.\d+$/);
  assert.match(contract.pnpm, /^\d+\.\d+\.\d+$/);
  assertWorkflowPins(workflow('product-full-ci.yml'), workflow('pack-release.yml'), workflow('publish-npm.yml'));
  assertHostedToolchain(contract.node, contract.pnpm);
});
test('hosted checks run after installing their workspace dependencies', () => {
  for (const [name, job] of [['product-full-ci.yml', 'classify'], ['pack-release.yml', 'pack'], ['publish-npm.yml', 'publish']]) {
    const steps = workflow(name).jobs[job].steps;
    const commands = steps.flatMap(step => (step.run ?? '').split('\n'));
    const install = commands.findIndex(line => /pnpm install|inputs\.dependency-command/.test(line));
    const check = commands.findIndex(line => line.includes('node scripts/ci-toolchain.mjs hosted'));
    assert.ok(install >= 0 && check > install, `${name}: install before the semver-dependent toolchain check`);
  }
});
for (const [index, name] of ['documentation', 'pack', 'publish'].entries()) {
  test(`contract rejects floating or drifted ${name} workflow pins`, () => {
    for (const version of ['24', '24.x', '24.21.0', '26.12.1']) {
      const workflows = [workflow('product-full-ci.yml'), workflow('pack-release.yml'), workflow('publish-npm.yml')];
      const steps = [workflows[0].jobs.classify.steps, workflows[1].jobs.pack.steps, workflows[2].jobs.publish.steps][index];
      steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version'] = version;
      assert.throws(() => assertWorkflowPins(...workflows));
    }
  });
}
test('Hosted runtime and pnpm drift are refused', () => {
  assert.throws(() => assertHostedToolchain('26.12.1', contract.pnpm));
  assert.throws(() => assertHostedToolchain(contract.node, '10.1.0'));
});
test('known affected Node boundaries are refused with their primary source', () => {
  for (const version of ['22.23.3', '24.2.0', '24.20.0', '24.21.0', '24.22.0', '26.9.0', '26.12.0']) {
    assert.throws(() => assertNodeAllowed(version), /Known affected Node.*https:\/\//);
  }
  for (const version of ['22.23.4', '24.22.1', '24.23.0', '26.12.1', '26.13.0']) assertNodeAllowed(version);
  assert.throws(() => assertNodeAllowed('20.19.0'), /engines/);
  for (const version of ['24', '24.22', '24.22.1-rc.1', 'invalid']) assert.throws(() => assertNodeAllowed(version));
});
test('native CI uses host Node without setup-node or exact pin and checks actual SQLite capability', () => {
  const full = workflow('product-full-ci.yml').jobs.full.steps;
  assert.ok(!full.some(step => step.uses?.startsWith('actions/setup-node@')));
  const command = workflow('ci.yml').jobs.full.with['full-command'];
  assert.match(command, /ci-toolchain\.mjs version && corepack pnpm build && node scripts\/ci-toolchain\.mjs native/);
  const checker = read('./ci-toolchain.mjs');
  assert.match(checker, /assertSqliteSearchCapability\(\)/);
  assert.match(checker, /node: process\.version, execPath: process\.execPath, sqlite: process\.versions\.sqlite/);
  assert.match(read('./managed-native-hash-proof.mjs'), /node:process\.version,execPath:process\.execPath,sqlite:process\.versions\.sqlite/);
});
test('both documentation and release gates execute the shared contract tests', () => {
  assert.match(read('./check-current-docs.mjs'), /--test[\s\S]*ci-toolchain\.test\.mjs/);
  assert.match(JSON.parse(read('../package.json')).scripts['check:release-smoke'], /ci-toolchain\.test\.mjs/);
});
