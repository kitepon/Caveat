import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, symlinkSync, renameSync, realpathSync, statSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { bindGlobalMigration } from '../src/managedGlobalMigration.js';
import { stageManagedDeployment, activateManagedDeployment, managedDeploymentPaths } from '../src/managedDeployment.js';
import { globalNpmEnvironment, globalNpmLayout, isWindows } from '../src/platform.js';
import { runWindowsAclPrivateTree } from '../src/privateWindowsAcl.js';
import type { NativeProcessTables } from '../src/managedProcessNative.js';
import { inspectGlobalMigrationRecovery } from '../src/managedGlobalRecovery.js';
import { prepareGlobalShellInstallation } from '../src/managedGlobalShell.js';
import { runOwnedGlobalNpm, globalUninstallArguments } from '../src/managedGlobalNpm.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function tables(unknown = false): NativeProcessTables {
  const stat = statSync(process.execPath, { bigint: true }), executable = { path: realpathSync(process.execPath), dev: String(stat.dev), ino: String(stat.ino) };
  const self = { pid: process.pid, ppid: process.ppid, birth: 'fixture-birth', uid: 1000, executable, argv: [process.execPath, 'fixture-managed-entry'], state: 'S' };
  const rows = unknown ? [self, { ...self, pid: process.pid + 123, birth: 'fixture-other', argv: [process.execPath, '-e', 'unknown code'] }] : [self];
  return { before: rows, after: structuredClone(rows), errors: [], selfPid: process.pid, selfExecutable: executable, caseInsensitive: isWindows() };
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-migration-'))); roots.push(root);
  const profile = join(root, 'profile'), prefix = join(root, 'prefix'), globalRoot = isWindows() ? join(prefix, 'node_modules') : join(prefix, 'lib/node_modules');
  const binDirectory = isWindows() ? prefix : join(prefix, 'bin'), packageRoot = join(globalRoot, 'caveat-cli');
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 }); mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(globalRoot, 'other'), { mode: 0o700 }); writeFileSync(join(globalRoot, 'other/index.js'), 'other global remains', { mode: 0o600 });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '0.9.0', bin: { caveat: 'dist/caveat.js' } }), { mode: 0o600 });
  writeFileSync(join(packageRoot, 'dist/caveat.js'), '#!/usr/bin/env node\n', { mode: 0o700 });
  for (const name of isWindows() ? ['caveat', 'caveat.cmd', 'caveat.ps1'] : ['caveat']) writeFileSync(join(binDirectory, name), 'fixture old wrapper', { mode: 0o700 });
  const source = join(root, 'managed-source'); mkdirSync(join(source, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '1.0.0', bin: { caveat: 'dist/caveat.js' } }), { mode: 0o600 });
  for (const name of ['caveat.js', 'stable-entry.mjs', 'managed-deployment.js']) writeFileSync(join(source, 'dist', name), '// managed fixture ' + name + '\n', { mode: 0o600 });
  const npmAlias = join(root, 'npm/bin/npm-cli.js'); mkdirSync(dirname(npmAlias), { recursive: true, mode: 0o700 });
  writeFileSync(npmAlias, 'Fixture source; never execute this as npm.', { mode: 0o600 }); writeFileSync(join(root, 'npm/package.json'), JSON.stringify({ name: 'npm', version: '11.0.0' }), { mode: 0o600 });
  const config = join(profile, 'config.json'); writeFileSync(config, '{"unchanged":true}\n', { mode: 0o600 });
  if (isWindows()) runWindowsAclPrivateTree(root);
  const options = { userHome: profile }, staged = stageManagedDeployment(source, options); activateManagedDeployment(staged.release, options);
  const paths = managedDeploymentPaths(profile);
  const input = { binDirectory, snapshot: { packageRoot, globalRoot, expectedPackageVersion: '0.9.0', node: process.execPath, nodeVersion: process.version,
    npmAlias, pointer: paths.pointer, expectedRelease: staged.release, protectedFiles: [paths.pointer, config], pins: [paths.pointer, config].map(file => ({ file, sha256: sha(readFileSync(file)) })) } };
  return { root, profile, prefix, globalRoot, packageRoot, binDirectory, paths, config, input };
}
describe('product global migration caller', () => {
  it('connects fresh baseline checks to original preservation, working copies and exact restoration', { timeout: 60000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    const pointer = readFileSync(f.paths.pointer), config = readFileSync(f.config);
    try {
      expect(existsSync(f.paths.lock)).toBe(true);
      expect(() => stageManagedDeployment(join(f.root, 'managed-source'), { userHome: f.profile })).toThrow('installer_busy');
      expect(session.runDirectory.startsWith(f.paths.root)).toBe(true); expect(session.engine.manifest().objects).toHaveLength(isWindows() ? 4 : 2);
      expect((await session.engine.preserveAll()).status).toBe('preserved'); expect((await session.engine.createWorkingCopies()).status).toBe('working');
      await session.verify();
      for (const row of session.engine.manifest().objects) { expect((await session.engine.quarantineWorking(row.step)).status).toBe('confirmed'); expect((await session.engine.restoreKnown(row.step)).status).toBe('confirmed'); }
      expect(readFileSync(f.paths.pointer)).toEqual(pointer); expect(readFileSync(f.config)).toEqual(config);
    } finally { session.close(); }
    expect(existsSync(f.paths.lock)).toBe(false); expect(existsSync(join(session.runDirectory, 'installer-lock.json'))).toBe(true);
  });
  it('rejects unknown processes before creating run state or moving originals', { timeout: 60000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root);
    await expect(bindGlobalMigration(f.input, () => {}, async () => tables(true))).rejects.toThrow('process_preflight_stopped');
    expect(readdirSync(f.paths.root)).toEqual(before); expect(existsSync(f.packageRoot)).toBe(true);
  });
  it('keeps an existing installer lock untouched before creating a run', { timeout: 60000 }, async () => {
    const f = fixture(), bytes = Buffer.from('{"schema":1,"pid":1,"startedAt":"2026-01-01T00:00:00Z"}\n'); writeFileSync(f.paths.lock, bytes, { mode: 0o600 });
    const before = readdirSync(f.paths.root);
    await expect(bindGlobalMigration(f.input, () => {}, async () => tables())).rejects.toThrow('installer_busy');
    expect(readFileSync(f.paths.lock)).toEqual(bytes); expect(readdirSync(f.paths.root)).toEqual(before);
  });
  it('rechecks process status before the first original move', { timeout: 60000 }, async () => {
    const f = fixture(); let blocked = false; const session = await bindGlobalMigration(f.input, () => {}, async () => tables(blocked)); blocked = true;
    try { expect((await session.engine.preserveAll()).status).toBe('stopped'); expect(session.journal.read().records).toHaveLength(0); expect(existsSync(f.packageRoot)).toBe(true); }
    finally { session.close(); }
  });
  it('stops on changed other-global content instead of mutating the target', { timeout: 60000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try { writeFileSync(join(f.globalRoot, 'other/index.js'), 'external update'); expect((await session.engine.preserveAll()).status).toBe('stopped'); expect(session.journal.read().records).toHaveLength(0); }
    finally { session.close(); }
  });
  it('keeps actual npm global uninstall within an isolated prefix and preserves the original and managed deployment', { timeout: 120000 }, async () => {
    const f = fixture();
    const bundled = isWindows() ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : join(dirname(dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js');
    let npm = bundled;
    if (!existsSync(npm)) {
      const installed = (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, 'npm')).filter(file => existsSync(file)).map(file => realpathSync(file));
      npm = installed.find(file => basename(file) === 'npm-cli.js') ?? bundled;
    }
    expect(existsSync(npm), 'the integration fixture requires the installed npm CLI').toBe(true);
    const control = join(f.root, 'npm-control'); mkdirSync(control, { mode: 0o700 });
    const userConfig = join(control, 'user.npmrc'), globalConfig = join(control, 'global.npmrc'); writeFileSync(userConfig, '\n', { mode: 0o600 }); writeFileSync(globalConfig, '\n', { mode: 0o600 });
    const packageSource = join(f.root, 'legacy-source'); mkdirSync(join(packageSource, 'dist'), { recursive: true, mode: 0o700 });
    writeFileSync(join(packageSource, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '0.9.0', bin: { caveat: 'dist/caveat.js' }, scripts: { preuninstall: 'node -e "process.exit(77)"' } }), { mode: 0o600 });
    writeFileSync(join(packageSource, 'dist/caveat.js'), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o700 });
    rmSync(f.packageRoot, { recursive: true }); for (const name of isWindows() ? ['caveat', 'caveat.cmd', 'caveat.ps1'] : ['caveat']) rmSync(join(f.binDirectory, name));
    const env = globalNpmEnvironment(process.execPath, control), common = ['--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(control, 'cache')];
    const pack = spawnSync(process.execPath, [npm, 'pack', packageSource, '--pack-destination', control, ...common], { cwd: control, env, encoding: 'utf8', timeout: 20000 });
    expect(pack.status, pack.stderr).toBe(0);
    const install = spawnSync(process.execPath, [npm, 'install', '--global', '--prefix', f.prefix, join(control, 'caveat-cli-0.9.0.tgz'), ...common], { cwd: control, env, encoding: 'utf8', timeout: 20000 });
    expect(install.status, install.stderr).toBe(0); f.input.snapshot.npmAlias = npm;
    const before = readFileSync(join(f.packageRoot, 'package.json')), pointer = readFileSync(f.paths.pointer);
    const session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try {
      expect((await session.engine.preserveAll()).status).toBe('preserved'); expect((await session.engine.createWorkingCopies()).status).toBe('working');
      const events: string[] = [], result = await session.uninstall(event => events.push(event.event));
      expect(result.status, JSON.stringify(result)).toBe('removed'); expect(events).toEqual(['issued', 'started', 'exit', 'close']);
      expect(existsSync(f.packageRoot)).toBe(false); expect(readFileSync(join(session.runDirectory, 'original-package/package.json'))).toEqual(before);
      for (const row of session.engine.manifest().objects) { if (row.working?.status === 'after-known') expect((await session.engine.quarantineWorking(row.step)).status).toBe('confirmed'); expect((await session.engine.restoreKnown(row.step)).status).toBe('confirmed'); }
      expect(readFileSync(join(f.packageRoot, 'package.json'))).toEqual(before); expect(readFileSync(f.paths.pointer)).toEqual(pointer);
    } finally { session.close(); }
  });
});

describe('owned npm child protocol', () => {
  it('binds only caveat-cli, fixed prefix, private npm config and no lifecycle/network operation', () => {
    const command = { node: '/node', script: '/npm/bin/npm-cli.js', prefix: '/prefix', runDirectory: '/run', userConfig: '/run/user', globalConfig: '/run/global' };
    const args = globalUninstallArguments(command); expect(args.at(-1)).toBe('caveat-cli'); expect(args).toContain('--ignore-scripts'); expect(args).toContain('--offline');
    expect(globalNpmEnvironment('/node', '/run').NODE_OPTIONS).toBeUndefined(); expect(globalNpmLayout(isWindows() ? 'C:/prefix/node_modules' : '/prefix/lib/node_modules').prefix).toContain('prefix');
  });
  it('observes started, exit and close separately without returning child output', async () => {
    const events: string[] = [], receipt = await runOwnedGlobalNpm(process.execPath, ['-e', "process.stdout.write('fixture-private-output')"], tmpdir(), {}, event => events.push(event.event), 5000);
    expect(receipt.status).toBe('completed'); expect(receipt.exitObserved).toBe(true); expect(receipt.closeObserved).toBe(true); expect(events).toEqual(['issued', 'started', 'exit', 'close']);
    expect(JSON.stringify(receipt)).not.toContain('fixture-private-output');
  });
  it('stops its owned child if durable progress observation fails', async () => {
    const receipt = await runOwnedGlobalNpm(process.execPath, ['-e', 'setInterval(()=>{},1000)'], tmpdir(), {}, event => { if (event.event === 'started') throw Error('receipt sink unavailable'); }, 5000);
    expect(receipt.status).toBe('unknown'); expect(receipt.reason).toBe('global_npm_receipt_failed'); expect(receipt.terminationRequested).toBe(true);
  });
  it('retains nonzero and timeout as unknown and terminates only the owned child once', async () => {
    const failed = await runOwnedGlobalNpm(process.execPath, ['-e', 'process.exit(7)'], tmpdir(), {}, () => {}, 5000);
    expect(failed.status).toBe('unknown'); expect(failed.exitCode).toBe(7); expect(failed.closeObserved).toBe(true);
    const timeout = await runOwnedGlobalNpm(process.execPath, ['-e', 'setInterval(()=>{},1000)'], tmpdir(), {}, () => {}, 100);
    expect(timeout.status).toBe('unknown'); expect(timeout.terminationRequested).toBe(true); expect(timeout.reason).toBe('global_npm_timeout');
  });
});


async function removeFixtureWorking(session: Awaited<ReturnType<typeof bindGlobalMigration>>) {
  expect((await session.engine.preserveAll()).status).toBe('preserved');
  expect((await session.engine.createWorkingCopies()).status).toBe('working');
  const paths = session.engine.manifest().objects.map(row => join(row.directory, row.name));
  const result = await session.engine.uninstallWorking(() => runOwnedGlobalNpm(process.execPath,
    ['-e', "for(const file of process.argv.slice(1))require('node:fs').rmSync(file,{recursive:true})", ...paths],
    session.runDirectory, {}, () => {}, 5000));
  expect(result.status).toBe('removed');
}
describe('product-owned shell publication and known-only rollback', () => {
  it('publishes all generated leaves and a native manifest, then quarantines them before restoring originals', { timeout: 120000 }, async () => {
    const f = fixture(), before = statSync(join(f.binDirectory, 'caveat')).ino, session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try {
      await removeFixtureWorking(session);
      expect((await session.shell.install()).status).toBe('installed'); expect(session.shell.status().status).toBe('ready');
      for (const row of session.plan.shellPlan.files) expect(readFileSync(row.path, 'utf8')).toBe(row.content);
      expect(statSync(join(f.binDirectory, 'caveat')).ino).not.toBe(before);
      expect(JSON.parse(readFileSync(join(f.paths.root, 'shell/manifest.json'), 'utf8'))).toMatchObject({ schema: 'caveat.managed_shell.v2', registrationNode: realpathSync(process.execPath) });
      await session.verify(); expect((await session.shell.quarantineKnown()).status).toBe('quarantined');
      for (const row of session.engine.manifest().objects) expect((await session.engine.restoreKnown(row.step)).status).toBe('confirmed');
      expect(readFileSync(join(f.binDirectory, 'caveat'), 'utf8')).toBe('fixture old wrapper'); expect(statSync(join(f.binDirectory, 'caveat')).ino).toBe(before);
      expect(existsSync(join(f.paths.root, 'shell'))).toBe(false); expect(existsSync(join(session.runDirectory, 'used-generated-shell/manifest.json'))).toBe(true);
    } finally { session.close(); }
  });
  it('binds originally absent leaves to only its own new objects and restores the original absence', { timeout: 120000 }, async () => {
    const f = fixture(); for (const name of isWindows() ? ['caveat', 'caveat.cmd', 'caveat.ps1'] : ['caveat']) rmSync(join(f.binDirectory, name));
    const session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try {
      await removeFixtureWorking(session); expect((await session.shell.install()).status).toBe('installed'); await session.verify();
      expect((await session.shell.quarantineKnown()).status).toBe('quarantined');
      for (const row of session.engine.manifest().objects) expect((await session.engine.restoreKnown(row.step)).status).toBe('confirmed');
      expect(existsSync(join(f.binDirectory, 'caveat'))).toBe(false);
      writeFileSync(join(f.binDirectory, 'caveat'), 'new foreign wrapper'); await expect(session.verify()).rejects.toThrow('absent_leaf_appeared');
    } finally { session.close(); }
  });
  it('retains known partial publication when preflight stops before the manifest and permits only a fresh known quarantine', { timeout: 120000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables()); let calls = 0;
    try {
      await removeFixtureWorking(session);
      const shell = prepareGlobalShellInstallation(session.guard, session.journal, session.engine, session.runDirectory, f.paths.root, session.plan.shellPlan,
        async () => { if (++calls === session.plan.shellPlan.files.length * 2 + 1) throw Error('fixture stopped before manifest'); await session.verify(); });
      expect((await shell.install()).status).toBe('stopped'); expect(session.journal.read().status).toBe('ready');
      expect(shell.snapshot().files.every(row => row.status === 'installed')).toBe(true); expect(existsSync(join(f.paths.root, 'shell'))).toBe(false);
      expect((await shell.quarantineKnown()).status).toBe('quarantined');
      for (const row of session.engine.manifest().objects) expect((await session.engine.restoreKnown(row.step)).status).toBe('confirmed');
    } finally { session.close(); }
  });
  it('keeps an uncertain post-rename leaf and exact observations without replaying or overwriting it', { timeout: 120000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try {
      await removeFixtureWorking(session); const move = session.guard.moveTreeNoReplace; let calls = 0;
      session.guard.moveTreeNoReplace = (...args) => { const result = move(...args); if (++calls === 1) throw Error('fixture lost publication receipt'); return result; };
      expect((await session.shell.install()).status).toBe('unknown'); expect(session.journal.read().status).toBe('unknown');
      expect(readFileSync(join(f.binDirectory, 'caveat'), 'utf8')).toBe(session.plan.shellPlan.files[0]!.content);
      const last = session.journal.read().records.at(-1)!;
      const state = JSON.parse(readFileSync(join(session.runDirectory, 'state-' + session.journal.read().header.runId + '-' + last.sequence + '.json'), 'utf8'));
      expect(state.result.observations).toMatchObject({ destination: { state: 'present' }, stage: { state: 'absent' } });
      await expect(session.shell.quarantineKnown()).rejects.toThrow('uncertain_or_interrupted'); expect(calls).toBe(1);
      expect((await session.engine.restoreKnown('package')).status).toBe('stopped'); expect(existsSync(f.packageRoot)).toBe(false); expect(session.shell.status().status).toBe('unknown');
    } finally { session.close(); }
  });
  it('refuses an existing shell ownership directory before any private run is created', { timeout: 60000 }, async () => {
    const f = fixture(); mkdirSync(join(f.paths.root, 'shell')); writeFileSync(join(f.paths.root, 'shell/keep'), 'existing product state');
    const before = readdirSync(f.paths.root);
    await expect(bindGlobalMigration(f.input, () => {}, async () => tables())).rejects.toThrow('shell_already_installed');
    expect(readdirSync(f.paths.root)).toEqual(before); expect(readFileSync(join(f.paths.root, 'shell/keep'), 'utf8')).toBe('existing product state');
  });
});


describe('persisted global migration recovery inspection', () => {
  it('opens installed shell/original evidence read-only with no execution permission', { timeout: 120000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try { await removeFixtureWorking(session); expect((await session.shell.install()).status).toBe('installed'); } finally { session.close(); }
    const before = readdirSync(session.runDirectory), journal = readFileSync(join(session.runDirectory, 'journal.jsonl'));
    const result = await inspectGlobalMigrationRecovery(session.runDirectory, session.planSha256);
    expect(result).toMatchObject({ status: 'observed', reason: 'recorded_state_matches', filesystemWrites: 0, childProcesses: 0, executionPermission: false, automaticRecovery: false });
    expect(result.observations.every(row => ['known', 'absent'].includes(row.state))).toBe(true);
    expect(readdirSync(session.runDirectory)).toEqual(before); expect(readFileSync(join(session.runDirectory, 'journal.jsonl'))).toEqual(journal);
  });
  it.each(['pending', 'unknown', 'torn'] as const)('stops on a %s journal without replay or writes', { timeout: 60000 }, async kind => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try {
      expect((await session.engine.preserveAll()).status).toBe('preserved');
      if (kind !== 'torn') session.journal.intent('interruption', 'wrapper', 'a'.repeat(64));
      if (kind === 'unknown') session.journal.result('interruption', 'wrapper', 'unknown', null);
    } finally { session.close(); }
    if (kind === 'torn') appendFileSync(join(session.runDirectory, 'journal.jsonl'), '{incomplete');
    const before = readFileSync(join(session.runDirectory, 'journal.jsonl'));
    expect(await inspectGlobalMigrationRecovery(session.runDirectory, session.planSha256)).toMatchObject({ status: 'stopped', reason: 'interrupted_or_unknown', journalStatus: kind, filesystemWrites: 0 });
    expect(readFileSync(join(session.runDirectory, 'journal.jsonl'))).toEqual(before); expect(existsSync(f.packageRoot)).toBe(false);
  });
  it('refuses a changed state file and wrong plan hash without changing originals', { timeout: 60000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables()); let name: string;
    try { await session.engine.preserveAll(); const current = session.journal.read(); name = 'state-' + current.header.runId + '-' + current.records.at(-1)!.sequence + '.json'; } finally { session.close(); }
    await expect(inspectGlobalMigrationRecovery(session.runDirectory, '0'.repeat(64))).rejects.toThrow('plan_hash_changed');
    const file = join(session.runDirectory, name!), bytes = readFileSync(file); writeFileSync(file, Buffer.concat([bytes, Buffer.from(' ')]));
    await expect(inspectGlobalMigrationRecovery(session.runDirectory, session.planSha256)).rejects.toThrow('state_hash_changed');
    expect(existsSync(join(session.runDirectory, 'original-package/package.json'))).toBe(true); expect(existsSync(f.packageRoot)).toBe(false);
  });
  it('keeps a changed original and reports its current state unknown rather than restoring or reconstructing it', { timeout: 60000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try { await session.engine.preserveAll(); } finally { session.close(); }
    const file = join(session.runDirectory, 'original-package/dist/caveat.js'); writeFileSync(file, 'changed original');
    const result = await inspectGlobalMigrationRecovery(session.runDirectory, session.planSha256);
    expect(result.status).toBe('stopped'); expect(result.observations).toContainEqual({ step: 'original.package', state: 'unknown' });
    expect(readFileSync(file, 'utf8')).toBe('changed original'); expect(existsSync(f.packageRoot)).toBe(false);
  });
});


it('binds an accepted bin alias and stops if it changes before preservation', { timeout: 60000 }, async () => {
  const f = fixture(), alias = join(f.root, 'bin-alias'), other = join(f.root, 'other-bin'); mkdirSync(other, { mode: 0o700 });
  symlinkSync(f.binDirectory, alias, isWindows() ? 'junction' : 'dir'); f.input.binDirectory = alias;
  const session = await bindGlobalMigration(f.input, () => {}, async () => tables());
  const journalBefore = readFileSync(join(session.runDirectory, 'journal.jsonl'));
  try {
    rmSync(alias); symlinkSync(other, alias, isWindows() ? 'junction' : 'dir');
    expect((await session.engine.preserveAll()).status).toBe('stopped'); expect(() => session.journal.read()).toThrow('alias_changed'); expect(readFileSync(join(session.runDirectory, 'journal.jsonl'))).toEqual(journalBefore); expect(existsSync(f.packageRoot)).toBe(true);
  } finally { expect(() => session.close()).toThrow('alias_changed'); expect(existsSync(f.paths.lock)).toBe(true); }
});
it.skipIf(isWindows())('rejects a redirected prefix bin before creating private run state', { timeout: 60000 }, async () => {
  const f = fixture(), moved = join(f.root, 'redirected-bin'); renameSync(f.binDirectory, moved); symlinkSync(moved, f.binDirectory, 'dir');
  const before = readdirSync(f.paths.root);
  await expect(bindGlobalMigration(f.input, () => {}, async () => tables())).rejects.toThrow('bin_redirect');
  expect(readdirSync(f.paths.root)).toEqual(before); expect(readFileSync(join(moved, 'caveat'), 'utf8')).toBe('fixture old wrapper');
});
