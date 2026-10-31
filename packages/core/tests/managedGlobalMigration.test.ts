import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, chmodSync, appendFileSync, symlinkSync, renameSync, realpathSync, statSync, rmSync, readdirSync, existsSync, truncateSync, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { recoverGlobalMigration, inspectGlobalRecoveryAttempt } from '../src/managedGlobalRecoveryExecution.js';
import { withGlobalRecoveryAttemptEvidence } from '../src/managedGlobalRecoveryAttempt.js';
import { planGlobalRecoveryWithCollector } from '../src/managedGlobalRecoveryChain.js';
import { parseGlobalMutationJournal } from '../src/managedGlobalJournal.js';
import { coordinateGlobalMigration } from '../src/managedGlobalCoordinator.js';
import { managedShellStatusCurrent } from '../src/managedGlobalShellStatus.js';
import { bindGlobalAdmission, bindGlobalMigration } from '../src/managedGlobalMigration.js';
import { stageManagedDeployment, activateManagedDeployment, managedDeploymentPaths } from '../src/managedDeployment.js';
import { globalNpmEnvironment, globalNpmLayout, isWindows } from '../src/platform.js';
import { runWindowsAclPrivateTree } from '../src/privateWindowsAcl.js';
import type { NativeProcessTables } from '../src/managedProcessNative.js';
import { assertGlobalRecoveryBinding, bindGlobalRecoveryProtected, globalRecoveryGuardPaths, inspectGlobalMigrationRecovery, withGlobalMigrationEvidence } from '../src/managedGlobalRecovery.js';
import { bindGlobalPathGuard, openGlobalPathGuard } from '../src/managedGlobalGuard.js';
import { createPosixGlobalGuard } from '../src/managedPosixGuard.js';
import { globalFilesystemNativeSpec } from '../src/platform.js';
import { digestOtherGlobals, changedOtherGlobals, snapshotGlobalTree } from '../src/managedGlobalSnapshot.js';
import { prepareGlobalShellInstallation } from '../src/managedGlobalShell.js';
import { runOwnedGlobalNpm, globalUninstallArguments } from '../src/managedGlobalNpm.js';

const roots: string[] = [];
let activeNpm = '/unselected/npm/bin/npm-cli.js';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function tables(writer = false): NativeProcessTables {
  const stat = statSync(process.execPath, { bigint: true }), executable = { path: realpathSync(process.execPath), dev: String(stat.dev), ino: String(stat.ino) };
  const self = { pid: process.pid, ppid: process.ppid, birth: 'fixture-birth', uid: 1000, executable, argv: [process.execPath, 'fixture-managed-entry'], state: 'S' };
  const rows = writer ? [self, { ...self, pid: process.pid + 123, birth: 'fixture-other', executable: null, argv: ['node', activeNpm, 'uninstall', '-g', 'caveat-cli'] }] : [self];
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
  const npmAlias = join(root, 'npm/bin/npm-cli.js'); activeNpm = npmAlias; mkdirSync(dirname(npmAlias), { recursive: true, mode: 0o700 });
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
  it('persists a bounded plan and prepares with unrelated metadata exceeding 16 MiB', { timeout: 60000 }, async () => {
    const f = fixture();
    let directory = join(f.globalRoot, 'other');
    // Stay below macOS PATH_MAX while retaining a real metadata set larger than 16 MiB.
    for (let i = 0; i < 3; i++) { directory = join(directory, 'd'.repeat(180)); mkdirSync(directory); }
    for (let i = 0; i < 20000; i++) writeFileSync(join(directory, 'file-' + String(i).padStart(5, '0') + '-'.repeat(180)), '');
    const rows = snapshotGlobalTree(f.globalRoot, { observeOnly: true, skip: ['caveat-cli', '.package-lock.json'], metadataOnly: true }).filter(row => row.relativePath);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(16 * 1024 * 1024);
    const admission = await bindGlobalAdmission(f.input, () => {}, async () => tables());
    try {
      expect(Buffer.byteLength(JSON.stringify(admission.plan))).toBeLessThan(16 * 1024 * 1024);
      const prepared = await admission.prepare(admission.planSha256);
      expect(statSync(join(prepared.runDirectory, 'plan.json')).size).toBeLessThan(16 * 1024 * 1024);
    } finally { admission.close(); }
  });
  it('normalizes digest order, supports old evidence and names a changed package', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-digest-')); roots.push(root);
    writeFileSync(join(root, 'index.js'), 'other global remains');
    const rows = snapshotGlobalTree(root, { observeOnly: true, metadataOnly: true });
    const before = digestOtherGlobals(rows), changed = structuredClone(rows); changed[1]!.mtimeNs += '1';
    expect(digestOtherGlobals([...rows].reverse())).toEqual(before);
    expect(changedOtherGlobals(before, rows)).toEqual([]);
    expect(changedOtherGlobals(digestOtherGlobals(changed), before)).toEqual([{ package: 'index.js', reason: 'other_global_changed' }]);
  });
  it.each(['migration', 'recovery'] as const)('observes large unrelated globals during %s without broadening retained trees', { timeout: 60000 }, async mode => {
    const f = fixture(), file = join(f.globalRoot, 'other/index.js');
    truncateSync(file, 129 * 1024 * 1024);
    expect(() => snapshotGlobalTree(join(f.globalRoot, 'other'))).toThrow('tree_byte_bound');
    const admission = await bindGlobalAdmission(f.input, () => {}, async () => tables());
    let guard: Awaited<ReturnType<typeof openGlobalPathGuard>> | undefined;
    let recoveryObserve: (() => ReturnType<ReturnType<typeof bindGlobalRecoveryProtected>['observe']>) | undefined;
    try {
      expect(existsSync(f.paths.lock)).toBe(false);
      expect(admission.plan.baseline.otherGlobals.packages.find(row => row.name === 'other')).toMatchObject({ entries: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(admission.plan.baseline.otherGlobals)).not.toContain('index.js');
      await admission.verify();
      let verify = admission.verify;
      if (mode === 'recovery') {
        // Recovery starts after migration releases its native mutation pins.
        admission.close();
        guard = await openGlobalPathGuard(globalRecoveryGuardPaths(admission.plan, f.paths.root));
        const protectedState = bindGlobalRecoveryProtected(admission.plan, guard);
        recoveryObserve = protectedState.observe;
        expect(recoveryObserve().find(row => row.step === 'other-globals')).toMatchObject({ state: 'known' });
        verify = async () => { protectedState.verify(); };
      }
      await verify();
      const before = statSync(file), fd = openSync(file, 'r+');
      try { writeSync(fd, Buffer.from('changed'), 0, 7, 128 * 1024 * 1024); } finally { closeSync(fd); }
      expect(statSync(file).size).toBe(before.size);
      await expect(verify()).rejects.toThrow(mode === 'migration' ? 'global_migration_other_globals_changed' : 'global_recovery_protected_state_changed');
      if (mode === 'migration') await expect(verify()).rejects.toMatchObject({ diagnostic: { records: [{ package: 'other', reason: 'other_global_changed' }] } });
      else expect(recoveryObserve!().find(row => row.step === 'other-globals')).toMatchObject({ state: 'unknown', records: [{ package: 'other', reason: 'other_global_changed' }] });
    } finally { try { guard?.close(); } finally { admission.close(); } }
  });
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
  it('rejects readable npm writers before creating run state or moving originals', { timeout: 60000 }, async () => {
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
    const privateNpm = join(f.root, 'ordinary-npm'); cpSync(dirname(dirname(npm)), privateNpm, { recursive: true }); npm = join(privateNpm, 'bin/npm-cli.js');
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

it('stops after a newly observed bound consumer without poisoning the confirmed package-retain journal', { timeout: 120000 }, async () => {
  const f = fixture(); let session: Awaited<ReturnType<typeof bindGlobalMigration>> | undefined;
  const collect = async () => {
    const value = tables();
    if (session?.engine.manifest().objects[0]?.state === 'preserved') {
      const row = { ...value.before[0]!, pid: process.pid + 123, birth: 'new-consumer', argv: [process.execPath, join(f.packageRoot, 'dist/caveat.js')] };
      value.before.push(row); value.after.push(structuredClone(row));
    }
    return value;
  };
  session = await bindGlobalMigration(f.input, () => {}, collect);
  const run = session.runDirectory, digest = session.planSha256;
  try {
    const stopped = await session.engine.preserveAll();
    expect(stopped).toMatchObject({ status: 'stopped', recovery: 'fresh-known-only-plan-required' });
    expect(session.journal.read()).toMatchObject({ status: 'ready', records: [{ kind: 'intent' }, { kind: 'result', outcome: 'confirmed' }] });
  } finally { session.close(); }
  const fresh = await planGlobalRecoveryWithCollector(run, digest, async () => tables());
  expect(fresh.status).toBe('ready');
  expect((await recoverGlobalMigration(run, digest, fresh.evidenceSha256!, () => {}, async () => tables())).status).toBe('restored');
  expect(existsSync(f.packageRoot)).toBe(true);
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
      expect(JSON.parse(readFileSync(join(f.paths.root, 'shell/manifest.json'), 'utf8'))).toMatchObject({ schema: 'caveat.managed_shell.v2', registrationNode: 'node' });
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
      writeFileSync(join(f.binDirectory, 'caveat'), 'new foreign wrapper'); await expect(session.verify()).rejects.toThrow('global_migration_absent_leaf_appeared');
    } finally { session.close(); }
  });
  it('retains known partial publication when preflight stops before the manifest and permits only a fresh known quarantine', { timeout: 120000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables()); let calls = 0;
    try {
      await removeFixtureWorking(session);
      const shell = prepareGlobalShellInstallation(session.guard, session.journal, session.engine, session.runDirectory, f.paths.root, session.plan.shellPlan,
        async () => { if (++calls === session.plan.shellPlan.files.length * 2 + 1) throw Error('fixture stopped before manifest'); await session.engine.verifyCurrent(); }, session.plan.baseline.node);
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


describe('native shell publication confirmation diagnostics', () => {
  it('confirms published manifest identities and a fresh recovery plan', { timeout: 120000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try {
      await removeFixtureWorking(session);
      const result = await session.shell.install();
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'installed' });
    } finally { session.close(); }
    const recovery = await planGlobalRecoveryWithCollector(session.runDirectory, session.planSha256, async () => tables());
    expect(recovery, JSON.stringify(recovery)).toMatchObject({ status: 'ready', currentObjects: 'confirmed' });
  });
  for (const attribute of ['ctime', 'securitySha256', 'contentSha256'] as const) it('identifies a binding and differing ' + attribute + ' without permitting recovery', () => {
    const row = { relativePath: 'manifest.json', identity: { dev: '1', ino: '2', kind: 'file' as const, size: '3', links: '1', mtime: '4', ctime: '5', owner: '6', group: '7', mode: 0o600, securitySha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64) } };
    const current = structuredClone(row); current.identity[attribute] = 'changed';
    try { assertGlobalRecoveryBinding(() => [current], [row], '/fixture/shell', 'manifest.json'); }
    catch (error) {
      expect(error).toMatchObject({ message: 'global_recovery_binding_changed', diagnostic: { directory: '/fixture/shell', name: 'manifest.json', records: [{ relativePath: 'manifest.json', attributes: [attribute] }] } });
      return;
    }
    throw Error('expected refusal');
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
    expect(result.status).toBe('stopped'); expect(result.observations).toContainEqual(expect.objectContaining({ step: 'original.package', state: 'unknown', diagnostic: expect.objectContaining({ directory: session.runDirectory, name: 'original-package' }) }));
    const recovery = await planGlobalRecoveryWithCollector(session.runDirectory, session.planSha256, async () => tables());
    expect(recovery).toMatchObject({ status: 'stopped', reason: 'global_recovery_current_state_unconfirmed', diagnostic: { observations: expect.arrayContaining([expect.objectContaining({ step: 'original.package', diagnostic: expect.objectContaining({ name: 'original-package', records: expect.arrayContaining([expect.objectContaining({ attributes: expect.arrayContaining(['contentSha256']) })]) }) })]) } });
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


it('stops publication when an original changes after the first wrapper and forbids further original mutation', { timeout: 120000 }, async () => {
  const f = fixture(); let armed = false, changed = false;
  const session = await bindGlobalMigration(f.input, () => {}, async () => {
    if (armed && !changed && existsSync(join(f.binDirectory, 'caveat'))) { changed = true; writeFileSync(join(f.paths.root, runName, 'original-package/dist/caveat.js'), 'changed original'); }
    return tables();
  });
  const runName = basename(session.runDirectory);
  try {
    await removeFixtureWorking(session); armed = true;
    expect((await session.shell.install()).status).toBe('unknown'); expect(changed).toBe(true); expect(session.journal.read().status).toBe('unknown');
    expect(existsSync(join(f.binDirectory, 'caveat'))).toBe(true); expect(existsSync(join(f.paths.root, 'shell'))).toBe(false);
    await expect(session.engine.restoreKnown('package')).rejects.toThrow('not_known');
    expect(readFileSync(join(session.runDirectory, 'original-package/dist/caveat.js'), 'utf8')).toBe('changed original');
  } finally { session.close(); }
});


describe('read-only admission and native-v2 independent status', () => {
  it('keeps admission read-only, isolates its returned plan, and consumes preparation only once', { timeout: 120000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root), admission = await bindGlobalAdmission(f.input, () => {}, async () => tables());
    expect(readdirSync(f.paths.root)).toEqual(before); expect(existsSync(f.paths.lock)).toBe(false);
    admission.plan.baseline.packageVersion = 'caller mutation';
    try {
      const prepared = await admission.prepare(admission.planSha256);
      expect(prepared.plan.baseline.packageVersion).toBe('0.9.0');
      await expect(admission.prepare(admission.planSha256)).rejects.toThrow('already_attempted');
    } finally { admission.close(); }
  });
  it('rejects a stale plan digest or a non-active pointer without creating run state', { timeout: 60000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root), admission = await bindGlobalAdmission(f.input, () => {}, async () => tables());
    try { await expect(admission.prepare('0'.repeat(64))).rejects.toThrow('expected_plan_changed'); expect(readdirSync(f.paths.root)).toEqual(before); }
    finally { admission.close(); }
    const alternate = join(f.paths.root, 'other.json'); writeFileSync(alternate, readFileSync(f.paths.pointer)); f.input.snapshot.pointer = alternate;
    await expect(bindGlobalAdmission(f.input, () => {}, async () => tables())).rejects.toThrow('active_pointer_required');
    expect(existsSync(f.paths.lock)).toBe(false);
  });
  it.skipIf(isWindows())('rejects a writable npm parent before creating private run state', { timeout: 60000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root); chmodSync(dirname(dirname(f.input.snapshot.npmAlias)), 0o770);
    await expect(bindGlobalAdmission(f.input, () => {}, async () => tables(), async paths => bindGlobalPathGuard(paths,
      await createPosixGlobalGuard(globalFilesystemNativeSpec(), { user: () => 'fixture-owner',
        group: gid => ({ name: 'shared-workers', gid, members: ['another-user'] }), namedGroup: () => null,
        primaryUsers: () => ({ uids: [process.geteuid!()] }) })))).rejects.toThrow('global_guard_writable_parent');
    expect(readdirSync(f.paths.root)).toEqual(before); expect(existsSync(f.paths.lock)).toBe(false); expect(existsSync(f.packageRoot)).toBe(true);
  });
  it('binds absent settings and their nearest existing parent before mutation', { timeout: 60000 }, async () => {
    const f = fixture(), absent = join(f.profile, 'new-client', 'settings.json'), input = { ...f.input, protectedAbsent: [absent] };
    const admission = await bindGlobalAdmission(input, () => {}, async () => tables());
    try {
      expect(admission.plan.absences).toMatchObject([{ path: absent, parent: f.profile }]);
      mkdirSync(dirname(absent));
      await expect(admission.prepare(admission.planSha256)).rejects.toThrow('global_migration_absence_changed'); expect(existsSync(f.paths.lock)).toBe(false);
    } finally { admission.close(); }
  });
  it('reopens native-v2 status after release and detects a missing wrapper without altering it', { timeout: 120000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try { await removeFixtureWorking(session); expect((await session.shell.install()).status).toBe('installed'); } finally { session.close(); }
    expect(await managedShellStatusCurrent({ userHome: f.profile })).toMatchObject({ native: true, status: 'ready', deployment: { payloadVerified: true } });
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../../../apps/cli/dist/caveat.js', import.meta.url)), 'deployment', 'status', '--json'],
      { env: { ...process.env, HOME: f.profile, USERPROFILE: f.profile, CAVEAT_HOME: join(f.profile, 'knowledge'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GROK_HOME: '', CURSOR_HOME: '' }, encoding: 'utf8', timeout: 30000 });
    expect(cli.status, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout)).toMatchObject({ status: 'ready', payloadVerified: true, shell: { native: true, status: 'ready' } });
    rmSync(join(f.binDirectory, 'caveat'));
    expect(await managedShellStatusCurrent({ userHome: f.profile })).toMatchObject({ native: true, status: 'changed', reason: 'wrapper_identity_or_bytes_changed', deployment: { payloadVerified: true } });
    expect(existsSync(join(f.binDirectory, 'caveat'))).toBe(false);
  });
  it('refuses a changed PATH Node command in the managed shell manifest', { timeout: 120000 }, async () => {
    const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables());
    try { await removeFixtureWorking(session); await session.shell.install(); } finally { session.close(); }
    const file = join(f.paths.root, 'shell/manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8')); manifest.node.command = 'unapproved-runtime';
    writeFileSync(file, JSON.stringify(manifest) + '\n');
    expect(await managedShellStatusCurrent({ userHome: f.profile })).toMatchObject({ native: true, status: 'unknown', reason: 'native_shell_unconfirmed', deployment: null });
    expect(JSON.parse(readFileSync(file, 'utf8')).node.command).toBe('unapproved-runtime');
  });
});
function fixtureCoordinatorAdmission(admission: Awaited<ReturnType<typeof bindGlobalAdmission>>) {
  return { ...admission, async prepare(digest: string) {
    const session = await admission.prepare(digest);
    return { ...session, uninstall: (emit = () => {}) => session.engine.uninstallWorking(() => runOwnedGlobalNpm(process.execPath,
      ['-e', "for(const file of process.argv.slice(1))require('node:fs').rmSync(file,{recursive:true})", ...session.engine.manifest().objects.map(row => join(row.directory, row.name))],
      session.runDirectory, {}, emit, 5000)) };
  } };
}
describe('product migration coordinator', () => {
  it('does not start preparation when the reviewed digest differs', { timeout: 60000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root), events: unknown[] = [];
    const result = await coordinateGlobalMigration(f.input, '0'.repeat(64), event => events.push(event), (input, event) => bindGlobalAdmission(input, event, async () => tables()));
    expect(result).toMatchObject({ status: 'stopped', phase: 'admission', runId: null }); expect(readdirSync(f.paths.root)).toEqual(before);
    expect(JSON.stringify(events)).not.toContain(f.root);
  });
  it('retains shell failure details in an unknown terminal result', { timeout: 120000 }, async () => {
    const f = fixture(), admission = await bindGlobalAdmission(f.input, () => {}, async () => tables());
    const result = await coordinateGlobalMigration(f.input, admission.planSha256, () => {}, async () => {
      const base = fixtureCoordinatorAdmission(admission);
      return { ...base, async prepare(digest: string) {
        const session = await base.prepare(digest);
        return { ...session, shell: { ...session.shell, async install() {
          return { status: 'unknown' as const, errorSha256: 'b'.repeat(64), reason: 'fixture-confirmation-failed',
            diagnostic: { path: join(f.paths.root, 'shell') }, shell: session.shell.snapshot(), recovery: 'fresh-known-only-plan-required' as const };
        } } };
      } };
    });
    expect(result).toMatchObject({ status: 'unknown', phase: 'wrappers', errorSha256: 'b'.repeat(64),
      reason: 'fixture-confirmation-failed', diagnostic: { path: join(f.paths.root, 'shell') },
      shell: { recovery: 'fresh-known-only-plan-required' }, recovery: { requiresFreshEvidence: true } });
  });
  it('connects all phases, closes the owning guard, and independently reads installed state', { timeout: 120000 }, async () => {
    const f = fixture(), admission = await bindGlobalAdmission(f.input, () => {}, async () => tables()), events: { sequence: number; phase: string; event: string }[] = [];
    const result = await coordinateGlobalMigration(f.input, admission.planSha256, event => events.push(event), async () => fixtureCoordinatorAdmission(admission));
    expect(result).toMatchObject({ status: 'completed', existingProcessOperations: 0, privilegeElevation: false });
    expect(events.map(row => row.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)).toMatchObject({ phase: 'terminal', event: 'completed' }); expect(existsSync(f.paths.lock)).toBe(false);
    expect(await managedShellStatusCurrent({ userHome: f.profile })).toMatchObject({ status: 'ready' });
    const inspected = await inspectGlobalMigrationRecovery(join(f.paths.root, result.runId!), admission.planSha256);
    expect(inspected).toMatchObject({ status: 'observed', journalStatus: 'complete', executionPermission: false });
  });
});


describe('coordinator readback changes after close', () => {
  for (const change of ['pointer', 'original', 'journal', 'journal-checkpoint'] as const) it('refuses a ready but changed ' + change, { timeout: 120000 }, async () => {
    const f = fixture();
    const admission = await bindGlobalAdmission(f.input, () => {}, async () => tables());
    const result = await coordinateGlobalMigration(f.input, admission.planSha256, event => {
      if (event.phase !== 'readback' || event.event !== (change === 'pointer' ? 'persisted-verified' : 'issued')) return;
      if (change === 'pointer') {
        const source = join(f.root, 'managed-source'); writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '1.0.1', bin: { caveat: 'dist/caveat.js' } }));
        const staged = stageManagedDeployment(source, { userHome: f.profile }); activateManagedDeployment(staged.release, { userHome: f.profile });
      } else if (change === 'journal-checkpoint') {
        const file = join(f.paths.root, event.runId!, 'journal.jsonl'), lines = readFileSync(file, 'utf8').trimEnd().split('\n'), completion = JSON.parse(lines.at(-1)!);
        completion.stateSha256 = '1'.repeat(64); lines[lines.length - 1] = JSON.stringify(completion); writeFileSync(file, lines.join('\n') + '\n');
      } else if (change === 'journal') {
        const file = join(f.paths.root, event.runId!, 'journal.jsonl'), header = readFileSync(file, 'utf8').split('\n')[0]!;
        writeFileSync(file, header + '\n' + JSON.stringify({ sequence: 1, previousSha256: sha(Buffer.from(header + '\n')), kind: 'complete', stateSha256: '0'.repeat(64) }) + '\n');
      } else if (change === 'original') {
        appendFileSync(join(f.paths.root, event.runId!, 'original-package/package.json'), '\n');
      }
    }, async () => fixtureCoordinatorAdmission(admission));
    expect(await managedShellStatusCurrent({ userHome: f.profile })).toMatchObject({ status: 'ready', ...(change === 'pointer' ? { deployment: { version: '1.0.1' } } : {}) });
    expect(result).toMatchObject({ status: 'unknown', phase: 'readback' }); expect(existsSync(f.paths.lock)).toBe(false);
  });
});

describe('built product global CLI', () => {
  it.skipIf(isWindows()).each(['global-plan', 'global-migrate'])('prints actionable parent diagnostics for %s without writes', { timeout: 60000 }, mode => {
    const f = fixture(); chmodSync(f.prefix, 0o777); const before = readdirSync(f.paths.root);
    const args = ['deployment', mode, '--global-root', f.globalRoot, '--npm-cli', f.input.snapshot.npmAlias, '--json'];
    if (mode === 'global-migrate') args.push('--expected-plan-sha256', '0'.repeat(64));
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../../../apps/cli/dist/caveat.js', import.meta.url)), ...args],
      { env: { ...process.env, HOME: f.profile, USERPROFILE: f.profile, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GROK_HOME: '', CURSOR_HOME: '' }, encoding: 'utf8', timeout: 60000 });
    expect(cli.status, cli.stderr).toBe(1);
    const result = JSON.parse(cli.stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({ status: 'stopped', reason: 'global_guard_writable_parent', filesystemWrites: 0, existingProcessOperations: 0,
      diagnostic: { path: f.prefix, mode: '0777', uid: String(process.getuid!()), gid: String(statSync(f.prefix).gid), remedy: expect.stringContaining('chmod o-w') } });
    expect(result.errorSha256).toMatch(/^[a-f0-9]{64}$/); expect(readdirSync(f.paths.root)).toEqual(before);
  });
  it('derives protected settings and accepts a real normal table without private run writes', { timeout: 120000 }, async () => {
    const f = fixture(), { globalMigrationInput } = await import('../../../apps/cli/src/commands/globalMigration.js');
    const options = { globalRoot: f.globalRoot, npmCli: f.input.snapshot.npmAlias };
    const selected = globalMigrationInput(options, f.profile, {});
    expect(selected.snapshot.protectedFiles).toEqual([f.paths.pointer]); expect(selected.protectedAbsent).toHaveLength(8);
    const settings = join(f.profile, '.claude.json'); writeFileSync(settings, '{"mcpServers":{}}\n', { mode: 0o600 });
    const next = globalMigrationInput(options, f.profile, {});
    expect(next.snapshot.protectedFiles).toEqual([f.paths.pointer, settings]); expect(next.protectedAbsent).toHaveLength(7);
    const before = readdirSync(f.paths.root), npmBefore = readFileSync(options.npmCli);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../../../apps/cli/dist/caveat.js', import.meta.url)), 'deployment', 'global-plan', '--global-root', options.globalRoot, '--npm-cli', options.npmCli, '--json'],
      { env: { ...process.env, HOME: f.profile, USERPROFILE: f.profile, CAVEAT_HOME: join(f.profile, 'knowledge'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GROK_HOME: '', CURSOR_HOME: '' }, encoding: 'utf8', timeout: 60000 });
    expect(cli.status, cli.stderr).toBe(0);
    const events = cli.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(events[0]).toMatchObject({ phase: 'input', event: 'issued', sequence: 1 });
    expect(events.at(-1)).toMatchObject({ status: 'ready', filesystemWrites: 0, existingProcessOperations: 0 });
    expect(events.map(row => row.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(cli.stdout).not.toContain(f.root); expect(readdirSync(f.paths.root)).toEqual(before); expect(existsSync(f.paths.lock)).toBe(false);
    expect(readFileSync(options.npmCli)).toEqual(npmBefore); expect(readFileSync(settings, 'utf8')).toBe('{"mcpServers":{}}\n');
  });
});


async function recoveryFixture(mode: 'backup' | 'working' | 'installed' | 'partial' | 'failed-known' = 'installed', setup: (f: ReturnType<typeof fixture>) => void = () => {}) {
  const f = fixture(), original = statSync(join(f.packageRoot, 'package.json')).ino, oldLeaf = readFileSync(join(f.binDirectory, 'caveat'));
  setup(f); const session = await bindGlobalMigration(f.input, () => {}, async () => tables());
  try {
    if (mode === 'failed-known') {
      expect((await session.engine.preserveAll()).status).toBe('preserved'); expect((await session.engine.createWorkingCopies()).status).toBe('working');
      const after = await session.engine.uninstallWorking(() => runOwnedGlobalNpm(process.execPath, ['-e', "require('node:fs').rmSync(require('node:path').join(process.argv[1],'dist/caveat.js'));process.exit(7)", f.packageRoot], session.runDirectory, {}, () => {}, 5000));
      expect(after.status).toBe('failed-known');
    } else if (mode === 'partial') {
      await removeFixtureWorking(session); let calls = 0;
      const shell = prepareGlobalShellInstallation(session.guard, session.journal, session.engine, session.runDirectory, f.paths.root, session.plan.shellPlan,
        async () => { if (++calls === session.plan.shellPlan.files.length * 2 + 1) throw Error('fixture before manifest'); await session.engine.verifyCurrent(); }, session.plan.baseline.node);
      expect((await shell.install()).status).toBe('stopped');
    } else if (mode === 'installed') { await removeFixtureWorking(session); expect((await session.shell.install()).status).toBe('installed'); session.journal.complete('a'.repeat(64)); }
    else { expect((await session.engine.preserveAll()).status).toBe('preserved'); if (mode === 'working') expect((await session.engine.createWorkingCopies()).status).toBe('working'); }
  } finally { session.close(); }
  const inspected = await inspectGlobalMigrationRecovery(session.runDirectory, session.planSha256);
  expect(inspected).toMatchObject({ status: 'observed', reason: 'recorded_state_matches' });
  assertRecoveryEvidence(inspected);
  const evidence = readdirSync(session.runDirectory).filter(name => /^(plan\.json|journal\.jsonl|originals-|state-|installer-lock\.json|user\.npmrc|global\.npmrc)/.test(name))
    .map(name => ({ name, bytes: readFileSync(join(session.runDirectory, name)) }));
  return { f, session, original, oldLeaf, evidenceSha256: inspected.evidenceSha256, unchanged() { for (const row of evidence) expect(readFileSync(join(session.runDirectory, row.name))).toEqual(row.bytes); } };
}
function assertRecoveryEvidence(value: unknown): asserts value is { evidenceSha256: string } {
  expect(value).toHaveProperty('evidenceSha256');
}
describe('separately journaled persisted recovery execution', () => {
  for (const mode of ['backup', 'working', 'installed', 'partial', 'failed-known'] as const) it('restores a known ' + mode + ' checkpoint without writing old evidence', { timeout: 120000 }, async () => {
    const r = await recoveryFixture(mode), events: { sequence: number; event: string }[] = [];
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => events.push(event), async () => tables());
    expect(result).toMatchObject({ status: 'restored', existingProcessOperations: 0, privilegeElevation: false });
    expect(statSync(join(r.f.packageRoot, 'package.json')).ino).toBe(r.original); expect(readFileSync(join(r.f.binDirectory, 'caveat'))).toEqual(r.oldLeaf);
    expect(existsSync(join(r.f.paths.root, 'shell'))).toBe(false); expect(existsSync(r.f.paths.lock)).toBe(false); r.unchanged();
    const attempt = join(r.f.paths.root, result.runId!), journal = parseGlobalMutationJournal(readFileSync(join(attempt, 'journal.jsonl')), r.session.planSha256);
    const finalRecord = journal.records.filter(row => row.kind === 'result').at(-1)!;
    expect(JSON.parse(readFileSync(join(attempt, 'state-' + journal.header.runId + '-' + finalRecord.sequence + '.json'), 'utf8'))).toMatchObject({ renameAttempted: true, renameIssued: true, state: { confirmed: true } });
    expect(journal.status).toBe('complete'); expect(await inspectGlobalRecoveryAttempt(attempt, r.session.planSha256)).toMatchObject({ status: 'observed', journalStatus: 'complete', currentObjects: 'not-assessed', executionPermission: false, filesystemWrites: 0 }); expect(events.map(row => row.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)?.event).toBe('restored');
  });
  it('stops a readable npm writer before creating a new run or changing the original', { timeout: 120000 }, async () => {
    const r = await recoveryFixture(), before = readdirSync(r.f.paths.root);
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, () => {}, async () => tables(true));
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0, runId: null }); expect(readdirSync(r.f.paths.root)).toEqual(before); r.unchanged();
    expect(existsSync(r.f.packageRoot)).toBe(false);
  });
  it('requires the reviewed full evidence digest before creating a run', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup'), before = readdirSync(r.f.paths.root);
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, '0'.repeat(64), () => {}, async () => tables());
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(before); r.unchanged();
  });
  it('leaves an interrupted new intent pending and never starts the same recovery again', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup');
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => { if (event.event === 'intent-persisted') throw Error('fixture transport lost'); }, async () => tables());
    expect(result).toMatchObject({ status: 'unknown' }); r.unchanged(); expect(existsSync(r.f.packageRoot)).toBe(false);
    const journal = readFileSync(join(r.f.paths.root, result.runId!, 'journal.jsonl')); expect(parseGlobalMutationJournal(journal, r.session.planSha256).status).toBe('pending');
    const before = readdirSync(r.f.paths.root), second = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, () => {}, async () => tables());
    expect(second).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(before);
    expect(readFileSync(join(r.f.paths.root, result.runId!, 'journal.jsonl'))).toEqual(journal); r.unchanged();
  });
});


describe('recovery fresh boundaries and immutable source evidence', () => {
  for (const changed of ['original', 'working', 'generated', 'protected', 'absent-setting', 'absent-management'] as const) it('refuses changed ' + changed + ' before private run creation', { timeout: 120000 }, async () => {
    const r = await recoveryFixture(changed === 'working' ? 'working' : 'installed', f => {
      if (changed === 'absent-setting') Object.assign(f.input, { protectedAbsent: [join(f.profile, 'new-settings.json')] });
    });
    if (changed === 'original') appendFileSync(join(r.session.runDirectory, 'original-package/package.json'), ' ');
    if (changed === 'working') appendFileSync(join(r.f.packageRoot, 'package.json'), ' ');
    if (changed === 'generated') appendFileSync(join(r.f.binDirectory, 'caveat'), 'changed');
    if (changed === 'protected') appendFileSync(r.f.config, ' ');
    if (changed === 'absent-setting') writeFileSync(join(r.f.profile, 'new-settings.json'), '{}');
    if (changed === 'absent-management') writeFileSync(join(r.f.globalRoot, '.package-lock.json'), '{}');
    const before = readdirSync(r.f.paths.root), result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, () => {}, async () => tables());
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0, runId: null }); expect(readdirSync(r.f.paths.root)).toEqual(before); r.unchanged();
  });
  it.skipIf(isWindows())('refuses changed parent protection without repairing it', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup'); chmodSync(r.f.paths.root, 0o755);
    const before = readdirSync(r.f.paths.root), result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, () => {}, async () => tables());
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(before); expect(statSync(r.f.paths.root).mode & 0o777).toBe(0o755); r.unchanged();
  });
  for (const kind of ['pending', 'torn', 'unknown'] as const) it('never executes a source ' + kind + ' intent', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup'), file = join(r.session.runDirectory, 'journal.jsonl'), current = parseGlobalMutationJournal(readFileSync(file), r.session.planSha256);
    const intent = JSON.stringify({ sequence: current.nextSequence, previousSha256: current.lastSha256, kind: 'intent', step: 'interrupted', operation: 'restore', stateSha256: 'a'.repeat(64) }) + '\n';
    appendFileSync(file, intent);
    if (kind === 'torn') appendFileSync(file, '{torn');
    if (kind === 'unknown') appendFileSync(file, JSON.stringify({ sequence: current.nextSequence + 1, previousSha256: sha(Buffer.from(intent)), kind: 'result', step: 'interrupted', operation: 'restore', stateSha256: null, outcome: 'unknown' }) + '\n');
    const before = readFileSync(file), dirs = readdirSync(r.f.paths.root), result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, () => {}, async () => tables());
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readFileSync(file)).toEqual(before); expect(readdirSync(r.f.paths.root)).toEqual(dirs);
  });
  it('leaves a foreign installer lock unchanged before creating a run', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup'), bytes = Buffer.from('foreign lock'); writeFileSync(r.f.paths.lock, bytes, { mode: 0o600 });
    const before = readdirSync(r.f.paths.root), result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, () => {}, async () => tables());
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readFileSync(r.f.paths.lock)).toEqual(bytes); expect(readdirSync(r.f.paths.root)).toEqual(before); r.unchanged();
  });
  it('rechecks the native process boundary after intent flush and before issuing a rename', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup'); let blocked = false;
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => { if (event.event === 'intent-persisted') blocked = true; }, async () => tables(blocked));
    expect(result).toMatchObject({ status: 'unknown' }); expect(existsSync(r.f.packageRoot)).toBe(false); r.unchanged();
    const attempt = join(r.f.paths.root, result.runId!), journal = parseGlobalMutationJournal(readFileSync(join(attempt, 'journal.jsonl')), r.session.planSha256);
    expect(journal.status).toBe('unknown'); const last = journal.records.at(-1)!;
    const record = JSON.parse(readFileSync(join(attempt, 'state-' + journal.header.runId + '-' + last.sequence + '.json'), 'utf8'));
    expect(record).toMatchObject({ renameAttempted: false, renameIssued: false, state: { confirmed: false } });
    expect(await inspectGlobalRecoveryAttempt(attempt, r.session.planSha256)).toMatchObject({ status: 'stopped', journalStatus: 'unknown', executionPermission: false });
  });
  it('persists a known partial restoration when a new process blocks the next step', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup'); let blocked = false;
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => { if (event.phase === 'restore-package' && event.event === 'completed') blocked = true; }, async () => tables(blocked));
    expect(result).toMatchObject({ status: 'unknown' }); expect(statSync(join(r.f.packageRoot, 'package.json')).ino).toBe(r.original); expect(existsSync(join(r.f.binDirectory, 'caveat'))).toBe(false); r.unchanged();
    const attempt = join(r.f.paths.root, result.runId!), journal = parseGlobalMutationJournal(readFileSync(join(attempt, 'journal.jsonl')), r.session.planSha256);
    expect(journal.status).toBe('ready'); expect(await inspectGlobalRecoveryAttempt(attempt, r.session.planSha256)).toMatchObject({ journalStatus: 'ready', currentObjects: 'not-assessed', executionPermission: false });
  });
  it('independently refuses a changed restored object after its writer guard closes', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup');
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => { if (event.phase === 'readback' && event.event === 'issued') appendFileSync(join(r.f.packageRoot, 'package.json'), 'changed'); }, async () => tables());
    expect(result).toMatchObject({ status: 'unknown', phase: 'readback' }); expect(readFileSync(join(r.f.packageRoot, 'package.json'), 'utf8')).toContain('changed'); r.unchanged();
  });
  it('restores npm management after the package and before the old leaf', { timeout: 120000 }, async () => {
    const r = await recoveryFixture('backup', f => writeFileSync(join(f.globalRoot, '.package-lock.json'), '{"lockfileVersion":3}\n', { mode: 0o600 })), phases: string[] = [];
    const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => { if (event.event === 'completed') phases.push(event.phase); }, async () => tables());
    expect(result).toMatchObject({ status: 'restored' }); expect(phases.indexOf('restore-package')).toBeLessThan(phases.indexOf('restore-npm-management')); expect(phases.indexOf('restore-npm-management')).toBeLessThan(phases.indexOf('restore-leaf')); r.unchanged();
    expect(readFileSync(join(r.f.globalRoot, '.package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}\n');
  });
});


it('uses the built recovery CLI with the real collector and read-only attempt inspector', { timeout: 120000 }, async () => {
  const r = await recoveryFixture('backup'), cli = fileURLToPath(new URL('../../../apps/cli/dist/caveat.js', import.meta.url));
  const env = { ...process.env, HOME: r.f.profile, USERPROFILE: r.f.profile, CAVEAT_HOME: join(r.f.profile, 'knowledge'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GROK_HOME: '', CURSOR_HOME: '' };
  const completed = spawnSync(process.execPath, [cli, 'deployment', 'global-recover', basename(r.session.runDirectory), '--plan-sha256', r.session.planSha256, '--evidence-sha256', r.evidenceSha256, '--json'], { env, encoding: 'utf8', timeout: 60000 });
  expect(completed.status, completed.stderr + completed.stdout).toBe(0); const events = completed.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(events[0]).toMatchObject({ phase: 'input', event: 'issued', sequence: 1 }); const restored = events.at(-1); expect(restored).toMatchObject({ status: 'restored' });
  expect(events.map(row => row.sequence)).toEqual(events.map((_, index) => index + 1)); expect(completed.stdout).not.toContain(r.f.root); r.unchanged();
  const inspected = spawnSync(process.execPath, [cli, 'deployment', 'global-inspect-recovery', restored.runId!, '--plan-sha256', r.session.planSha256, '--json'], { env, encoding: 'utf8', timeout: 30000 });
  expect(inspected.status, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout)).toMatchObject({ status: 'observed', journalStatus: 'complete', currentObjects: 'not-assessed', filesystemWrites: 0, childProcesses: 0, executionPermission: false }); r.unchanged();
});


it('keeps changed or torn recovery-attempt evidence read-only and without an execution permit', { timeout: 120000 }, async () => {
  const r = await recoveryFixture('backup'), result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, () => {}, async () => tables());
  expect(result.status).toBe('restored'); const directory = join(r.f.paths.root, result.runId!), file = join(directory, 'journal.jsonl'), bytes = readFileSync(file);
  appendFileSync(file, '{torn'); const torn = readFileSync(file);
  expect(await inspectGlobalRecoveryAttempt(directory, r.session.planSha256)).toMatchObject({ status: 'stopped', journalStatus: 'torn', executionPermission: false, currentObjects: 'not-assessed' });
  expect(readFileSync(file)).toEqual(torn); writeFileSync(file, bytes);
  const journal = parseGlobalMutationJournal(bytes, r.session.planSha256), row = journal.records.find(value => value.kind === 'result')!;
  const state = join(directory, 'state-' + journal.header.runId + '-' + row.sequence + '.json'); appendFileSync(state, ' '); const changed = readFileSync(state);
  await expect(inspectGlobalRecoveryAttempt(directory, r.session.planSha256)).rejects.toThrow('state_changed'); expect(readFileSync(state)).toEqual(changed); r.unchanged();
});

it('refuses a recovery-directory alias substituted after close', { timeout: 120000 }, async () => {
  const r = await recoveryFixture('installed');
  const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => {
    if (event.phase !== 'readback' || event.event !== 'issued') return;
    const directory = join(r.f.paths.root, event.runId!), relocated = directory + '.relocated'; renameSync(directory, relocated); symlinkSync(relocated, directory, isWindows() ? 'junction' : 'dir');
  }, async () => tables());
  expect(result).toMatchObject({ status: 'unknown', phase: 'readback' }); r.unchanged(); expect(statSync(join(r.f.packageRoot, 'package.json')).ino).toBe(r.original);
});

async function partialRecovery(mode: Parameters<typeof recoveryFixture>[0] = 'backup', stopPhase = 'restore-package') {
  const r = await recoveryFixture(mode); let blocked = false;
  const result = await recoverGlobalMigration(r.session.runDirectory, r.session.planSha256, r.evidenceSha256, event => {
    if (event.phase === stopPhase && event.event === 'completed') blocked = true;
  }, async () => tables(blocked));
  expect(result.status).toBe('unknown'); const attempt = join(r.f.paths.root, result.runId!);
  const journal = parseGlobalMutationJournal(readFileSync(join(attempt, 'journal.jsonl')), r.session.planSha256); expect(journal.status).toBe('ready');
  return { ...r, attempt, journal };
}
function savedRecoveryFiles(directory: string) {
  const files = readdirSync(directory).filter(name => /^(source\.json|journal\.jsonl|state-|installer-lock\.json)/.test(name))
    .map(name => ({ name, bytes: readFileSync(join(directory, name)) }));
  return () => { for (const row of files) expect(readFileSync(join(directory, row.name))).toEqual(row.bytes); };
}
async function freshRecoveryPlan(r: Awaited<ReturnType<typeof partialRecovery>>) {
  const before = readdirSync(r.f.paths.root), unchanged = savedRecoveryFiles(r.attempt);
  const plan = await planGlobalRecoveryWithCollector(r.attempt, r.session.planSha256, async () => tables());
  expect(plan).toMatchObject({ status: 'ready', currentObjects: 'confirmed', executionPermission: false, filesystemWrites: 0 });
  assertRecoveryEvidence(plan); expect(readdirSync(r.f.paths.root)).toEqual(before); unchanged(); r.unchanged(); return plan;
}
describe('fresh recovery from confirmed partial attempts', () => {
  for (const [mode, stop] of [['backup', 'restore-package'], ['working', 'quarantine-working'], ['installed', 'quarantine-generated'], ['partial', 'quarantine-generated'], ['failed-known', 'quarantine-working']] as const)
    it('rebinds a ' + mode + ' partial attempt and restores through a separate journal', { timeout: 180000 }, async () => {
      const r = await partialRecovery(mode, stop);
      if (mode === 'backup') { const file = join(r.attempt, 'source.json'), header = JSON.parse(readFileSync(file, 'utf8')); header.schema = 'caveat.global_recovery_source.v1'; delete header.admission; writeFileSync(file, JSON.stringify(header) + '\n'); }
      const unchanged = savedRecoveryFiles(r.attempt), plan = await freshRecoveryPlan(r);
      expect((await freshRecoveryPlan(r)).evidenceSha256).toBe(plan.evidenceSha256);
      const result = await recoverGlobalMigration(r.attempt, r.session.planSha256, plan.evidenceSha256, () => {}, async () => tables());
      expect(result).toMatchObject({ status: 'restored', existingProcessOperations: 0, privilegeElevation: false }); expect(result.runId).not.toBe(basename(r.attempt));
      expect(statSync(join(r.f.packageRoot, 'package.json')).ino).toBe(r.original); expect(readFileSync(join(r.f.binDirectory, 'caveat'))).toEqual(r.oldLeaf);
      expect(existsSync(join(r.f.paths.root, 'shell'))).toBe(false); unchanged(); r.unchanged();
      const second = join(r.f.paths.root, result.runId!);
      expect(await inspectGlobalRecoveryAttempt(second, r.session.planSha256)).toMatchObject({ currentObjects: 'not-assessed', executionPermission: false, journalStatus: 'complete' });
      const current = await planGlobalRecoveryWithCollector(second, r.session.planSha256, async () => tables()); expect(current.status).toBe('ready');
      const dirs = readdirSync(r.f.paths.root), repeated = await recoverGlobalMigration(r.attempt, r.session.planSha256, plan.evidenceSha256, () => {}, async () => tables());
      expect(repeated).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(dirs); unchanged(); r.unchanged();
    });
  for (const changed of ['current', 'source', 'protected', 'absent', 'writer', 'alias-parent'] as const) it('rejects a fresh plan after changed ' + changed, { timeout: 180000 }, async () => {
    const r = await partialRecovery(), unchanged = savedRecoveryFiles(r.attempt), plan = await freshRecoveryPlan(r);
    if (changed === 'current') appendFileSync(join(r.f.packageRoot, 'package.json'), 'changed');
    if (changed === 'source') appendFileSync(join(r.attempt, 'source.json'), ' ');
    if (changed === 'protected') appendFileSync(r.f.config, ' ');
    if (changed === 'absent') writeFileSync(join(r.f.binDirectory, 'caveat'), 'foreign object', { mode: 0o600 });
    if (changed === 'alias-parent') { const moved = r.attempt + '.moved'; renameSync(r.attempt, moved); symlinkSync(moved, r.attempt, isWindows() ? 'junction' : 'dir'); }
    const before = readdirSync(r.f.paths.root), result = await recoverGlobalMigration(r.attempt, r.session.planSha256, plan.evidenceSha256, () => {}, async () => tables(changed === 'writer'));
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(before); r.unchanged();
    if (changed !== 'source') unchanged();
    expect((await planGlobalRecoveryWithCollector(r.attempt, r.session.planSha256, async () => tables(changed === 'writer'))).status).toBe('stopped');
  });
  for (const kind of ['pending', 'torn', 'unknown'] as const) it('never resumes an attempt with a ' + kind + ' intent', { timeout: 180000 }, async () => {
    const r = await partialRecovery(), file = join(r.attempt, 'journal.jsonl'), j = r.journal;
    const intent = JSON.stringify({ sequence: j.nextSequence, previousSha256: j.lastSha256, kind: 'intent', step: 'interrupted', operation: 'restore', stateSha256: 'a'.repeat(64) }) + '\n';
    appendFileSync(file, intent); if (kind === 'torn') appendFileSync(file, '{torn');
    if (kind === 'unknown') appendFileSync(file, JSON.stringify({ sequence: j.nextSequence + 1, previousSha256: sha(Buffer.from(intent)), kind: 'result', step: 'interrupted', operation: 'restore', stateSha256: null, outcome: 'unknown' }) + '\n');
    const before = readdirSync(r.f.paths.root), unchanged = savedRecoveryFiles(r.attempt);
    expect((await planGlobalRecoveryWithCollector(r.attempt, r.session.planSha256, async () => tables())).status).toBe('stopped');
    const result = await recoverGlobalMigration(r.attempt, r.session.planSha256, 'a'.repeat(64), () => {}, async () => tables());
    expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(before); unchanged(); r.unchanged();
  });
  it('rejects a source cycle without creating an attempt or rewriting the chain', { timeout: 180000 }, async () => {
    const r = await partialRecovery(), file = join(r.attempt, 'source.json'), source = JSON.parse(readFileSync(file, 'utf8')); source.sourceRun = basename(r.attempt);
    writeFileSync(file, JSON.stringify(source) + '\n'); const before = readdirSync(r.f.paths.root), unchanged = savedRecoveryFiles(r.attempt);
    expect((await planGlobalRecoveryWithCollector(r.attempt, r.session.planSha256, async () => tables())).status).toBe('stopped');
    expect(readdirSync(r.f.paths.root)).toEqual(before); unchanged(); r.unchanged();
  });
});

it('continues through two confirmed partial journals without reusing either attempt', { timeout: 240000 }, async () => {
  const r = await partialRecovery('installed', 'quarantine-generated'), firstUnchanged = savedRecoveryFiles(r.attempt), first = await freshRecoveryPlan(r); let blocked = false;
  const second = await recoverGlobalMigration(r.attempt, r.session.planSha256, first.evidenceSha256, event => { if (event.phase === 'quarantine-generated' && event.event === 'completed') blocked = true; }, async () => tables(blocked));
  expect(second.status).toBe('unknown'); const attempt = join(r.f.paths.root, second.runId!), secondUnchanged = savedRecoveryFiles(attempt);
  const plan = await freshRecoveryPlan({ ...r, attempt });
  const last = await recoverGlobalMigration(attempt, r.session.planSha256, plan.evidenceSha256, () => {}, async () => tables());
  expect(last.status).toBe('restored'); expect(new Set([basename(r.attempt), second.runId, last.runId]).size).toBe(3);
  expect(statSync(join(r.f.packageRoot, 'package.json')).ino).toBe(r.original); firstUnchanged(); secondUnchanged(); r.unchanged();
  const finalSource = join(r.f.paths.root, last.runId!, 'source.json'), source = JSON.parse(readFileSync(finalSource, 'utf8'));
  source.admission.sourceDataSha256 = 'f'.repeat(64); writeFileSync(finalSource, JSON.stringify(source) + '\n');
  const before = readdirSync(r.f.paths.root); expect((await planGlobalRecoveryWithCollector(join(r.f.paths.root, last.runId!), r.session.planSha256, async () => tables())).status).toBe('stopped');
  expect(readdirSync(r.f.paths.root)).toEqual(before); firstUnchanged(); secondUnchanged(); r.unchanged();
});

it('derives scope from the original seed even when forged result files and journal hashes agree', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), sourcePath = join(r.attempt, 'source.json'), sourceBytes = readFileSync(sourcePath), journalPath = join(r.attempt, 'journal.jsonl');
  const journalBytes = readFileSync(journalPath), row = r.journal.records.find(value => value.kind === 'result')!;
  const file = join(r.attempt, 'state-' + r.journal.header.runId + '-' + row.sequence + '.json'), bytes = readFileSync(file), dirs = readdirSync(r.f.paths.root);
  for (const changed of ['path', 'order', 'inode', 'content', 'rename', 'source-digest', 'source-journal', 'admission'] as const) {
    const record = JSON.parse(bytes.toString()), source = JSON.parse(sourceBytes.toString());
    if (changed === 'path') record.state.objects[0].original.directory = r.f.profile;
    if (changed === 'order') record.step = 'restore.caveat';
    if (changed === 'inode') record.result.treeAfter[0].identity.ino = '123456';
    if (changed === 'content') record.result.treeAfter.find((value: { identity: { kind: string } }) => value.identity.kind === 'file').identity.contentSha256 = 'b'.repeat(64);
    if (changed === 'rename') record.renameIssued = false;
    if (changed === 'source-digest') source.evidenceSha256 = 'b'.repeat(64);
    if (changed === 'source-journal') source.journalSha256 = 'b'.repeat(64);
    if (changed === 'admission') source.admission = { directories: [r.f.profile] };
    writeFileSync(sourcePath, JSON.stringify(source) + '\n'); const data = Buffer.from(JSON.stringify(record) + '\n'); writeFileSync(file, data);
    const lines = journalBytes.toString().trim().split('\n').map(line => JSON.parse(line)); let encoded = JSON.stringify(lines[0]) + '\n';
    for (const event of lines.slice(1)) { event.previousSha256 = sha(Buffer.from(encoded.slice(encoded.lastIndexOf('\n', encoded.length - 2) + 1))); if (event.sequence === row.sequence) event.stateSha256 = sha(data); encoded += JSON.stringify(event) + '\n'; }
    writeFileSync(journalPath, encoded); const unchanged = savedRecoveryFiles(r.attempt);
    expect((await planGlobalRecoveryWithCollector(r.attempt, r.session.planSha256, async () => tables())).status, changed).toBe('stopped');
    const result = await recoverGlobalMigration(r.attempt, r.session.planSha256, 'a'.repeat(64), () => {}, async () => tables());
    expect(result, changed).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(dirs); unchanged(); r.unchanged();
  }
});

it('bounds source-chain depth before current-object admission', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), header = readFileSync(join(r.attempt, 'journal.jsonl'), 'utf8').split('\n')[0] + '\n'; let parent = basename(r.session.runDirectory);
  for (let i = 0; i < 9; i++) {
    const evidenceSha256 = createHash('sha256').update('bounded synthetic history ' + i).digest('hex'), name = 'global-recovery-' + evidenceSha256.slice(0, 32), directory = join(r.f.paths.root, name);
    mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, 'source.json'), JSON.stringify({ schema: 'caveat.global_recovery_source.v2', admission: null,
      sourceRun: parent, planSha256: r.session.planSha256, evidenceSha256, journalSha256: 'a'.repeat(64) }) + '\n', { mode: 0o600 });
    writeFileSync(join(directory, 'journal.jsonl'), header, { mode: 0o600 }); if (isWindows()) runWindowsAclPrivateTree(directory); parent = name;
  }
  const before = readdirSync(r.f.paths.root), result = await planGlobalRecoveryWithCollector(join(r.f.paths.root, parent), r.session.planSha256, async () => tables());
  expect(result.status).toBe('stopped'); expect(readdirSync(r.f.paths.root)).toEqual(before); r.unchanged();
});

it('keeps chain source files unchanged across a new pending intent and refuses to plan from it', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), unchanged = savedRecoveryFiles(r.attempt), plan = await freshRecoveryPlan(r);
  const result = await recoverGlobalMigration(r.attempt, r.session.planSha256, plan.evidenceSha256, event => { if (event.event === 'intent-persisted') throw Error('fixture lost observer'); }, async () => tables());
  expect(result.status).toBe('unknown'); const next = join(r.f.paths.root, result.runId!);
  expect(await inspectGlobalRecoveryAttempt(next, r.session.planSha256)).toMatchObject({ journalStatus: 'pending', currentObjects: 'not-assessed', executionPermission: false });
  expect((await planGlobalRecoveryWithCollector(next, r.session.planSha256, async () => tables())).status).toBe('stopped'); unchanged(); r.unchanged();
});

it('independently reopens every source directory after chain recovery closes', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), unchanged = savedRecoveryFiles(r.attempt), plan = await freshRecoveryPlan(r);
  const result = await recoverGlobalMigration(r.attempt, r.session.planSha256, plan.evidenceSha256, event => {
    if (event.phase === 'readback' && event.event === 'issued') { const moved = r.attempt + '.moved'; renameSync(r.attempt, moved); symlinkSync(moved, r.attempt, isWindows() ? 'junction' : 'dir'); }
  }, async () => tables());
  expect(result).toMatchObject({ status: 'unknown', phase: 'readback' }); unchanged(); r.unchanged(); expect(statSync(join(r.f.packageRoot, 'package.json')).ino).toBe(r.original);
});

it('uses the built read-only recovery plan CLI with its real native collector', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), unchanged = savedRecoveryFiles(r.attempt), cli = fileURLToPath(new URL('../../../apps/cli/dist/caveat.js', import.meta.url));
  const env = { ...process.env, HOME: r.f.profile, USERPROFILE: r.f.profile, CAVEAT_HOME: join(r.f.profile, 'knowledge'), CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GROK_HOME: '', CURSOR_HOME: '' };
  const before = readdirSync(r.f.paths.root), result = spawnSync(process.execPath, [cli, 'deployment', 'global-recovery-plan', basename(r.attempt), '--plan-sha256', r.session.planSha256, '--json'], { env, encoding: 'utf8', timeout: 60000 });
  expect(result.status, result.stderr).toBe(0); const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(events[0]).toMatchObject({ phase: 'input', event: 'issued', sequence: 1 }); expect(events.map(row => row.sequence)).toEqual(events.map((_, i) => i + 1));
  expect(events.at(-1)).toMatchObject({ schema: 'caveat.global_recovery_plan.v1', status: 'ready', executionPermission: false, filesystemWrites: 0 });
  expect(result.stdout).not.toContain(r.f.root); expect(readdirSync(r.f.paths.root)).toEqual(before); unchanged(); r.unchanged();
});

it('rechecks absent installer lock after the planning process probe without removing a new lock', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), unchanged = savedRecoveryFiles(r.attempt), before = readdirSync(r.f.paths.root), lock = Buffer.from('foreign installer');
  const result = await planGlobalRecoveryWithCollector(r.attempt, r.session.planSha256, async () => { writeFileSync(r.f.paths.lock, lock, { mode: 0o600 }); return tables(); });
  expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readFileSync(r.f.paths.lock)).toEqual(lock);
  expect(readdirSync(r.f.paths.root).filter(name => name !== 'installer.lock')).toEqual(before); unchanged(); r.unchanged();
});

it('shares bounded file and byte budgets across recovery source reads', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), before = readdirSync(r.f.paths.root), unchanged = savedRecoveryFiles(r.attempt);
  for (const budget of [{ files: 256, bytes: 0 }, { files: 0, bytes: 64 * 1024 * 1024 }]) {
    let reached = false;
    await expect(withGlobalRecoveryAttemptEvidence(r.attempt, r.session.planSha256, async () => { reached = true; }, budget)).rejects.toThrow('chain_evidence_bound');
    expect(reached).toBe(false);
  }
  expect(readdirSync(r.f.paths.root)).toEqual(before); unchanged(); r.unchanged();
});

it('refuses an unknown ancestor intent despite a confirmed immediate recovery journal', { timeout: 180000 }, async () => {
  const r = await partialRecovery(), file = join(r.session.runDirectory, 'journal.jsonl'), j = parseGlobalMutationJournal(readFileSync(file), r.session.planSha256);
  const intent = JSON.stringify({ sequence: j.nextSequence, previousSha256: j.lastSha256, kind: 'intent', step: 'interrupted', operation: 'restore', stateSha256: 'a'.repeat(64) }) + '\n';
  appendFileSync(file, intent); appendFileSync(file, JSON.stringify({ sequence: j.nextSequence + 1, previousSha256: sha(Buffer.from(intent)), kind: 'result', step: 'interrupted', operation: 'restore', stateSha256: null, outcome: 'unknown' }) + '\n');
  const before = readdirSync(r.f.paths.root), ancestor = readFileSync(file), unchanged = savedRecoveryFiles(r.attempt);
  const result = await planGlobalRecoveryWithCollector(r.attempt, r.session.planSha256, async () => tables());
  expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readdirSync(r.f.paths.root)).toEqual(before); expect(readFileSync(file)).toEqual(ancestor); unchanged();
});

it('rechecks a migration-source vacant leaf after the fresh planning probe', { timeout: 180000 }, async () => {
  const r = await recoveryFixture('backup'), before = readdirSync(r.f.paths.root), leaf = join(r.f.binDirectory, 'caveat'), bytes = Buffer.from('foreign leaf');
  const result = await planGlobalRecoveryWithCollector(r.session.runDirectory, r.session.planSha256, async () => { writeFileSync(leaf, bytes, { mode: 0o600 }); return tables(); });
  expect(result).toMatchObject({ status: 'stopped', filesystemWrites: 0 }); expect(readFileSync(leaf)).toEqual(bytes); expect(readdirSync(r.f.paths.root)).toEqual(before); r.unchanged();
});

it('binds native original seed identity to the reviewed plan despite self-consistent replacement hashes', { timeout: 180000 }, async () => {
  const r = await recoveryFixture('backup'), j = parseGlobalMutationJournal(readFileSync(join(r.session.runDirectory, 'journal.jsonl')), r.session.planSha256);
  const originalName = 'originals-' + j.header.runId + '.json', originalPath = join(r.session.runDirectory, originalName), seed = JSON.parse(readFileSync(originalPath, 'utf8'));
  seed.objects[0].rows[0].identity.ino = '987654321'; const seedBytes = Buffer.from(JSON.stringify(seed) + '\n'); writeFileSync(originalPath, seedBytes);
  const changed = new Map<number, string>();
  for (const row of j.records) if (row.kind === 'result') {
    const file = join(r.session.runDirectory, 'state-' + j.header.runId + '-' + row.sequence + '.json'), state = JSON.parse(readFileSync(file, 'utf8'));
    state.manifest.originalEvidence = { name: originalName, bytes: seedBytes.length, sha256: sha(seedBytes) };
    state.manifest.objects[0].rows[0].identity.ino = '987654321'; state.manifest.objects[0].stateSha256 = sha(Buffer.from(JSON.stringify(state.manifest.objects[0].rows)));
    const bytes = Buffer.from(JSON.stringify(state) + '\n'); writeFileSync(file, bytes); changed.set(row.sequence, sha(bytes));
  }
  let previous = JSON.stringify(j.header) + '\n', encoded = previous;
  for (const original of j.records) { const row = { ...original, previousSha256: sha(Buffer.from(previous)), ...(changed.has(original.sequence) ? { stateSha256: changed.get(original.sequence) } : {}) }; previous = JSON.stringify(row) + '\n'; encoded += previous; }
  writeFileSync(join(r.session.runDirectory, 'journal.jsonl'), encoded); const before = readdirSync(r.f.paths.root), sourceBytes = readFileSync(join(r.session.runDirectory, 'journal.jsonl')); let reached = false;
  await expect(withGlobalMigrationEvidence(r.session.runDirectory, r.session.planSha256, async () => { reached = true; })).rejects.toThrow('original_seed_unbound');
  expect(reached).toBe(false); expect(readdirSync(r.f.paths.root)).toEqual(before); expect(readFileSync(join(r.session.runDirectory, 'journal.jsonl'))).toEqual(sourceBytes);
});

for (const kind of ['working', 'wrapper'] as const) it('rejects self-consistent ' + kind + ' content hashes not bound to the approved source', { timeout: 180000 }, async () => {
  const r = await recoveryFixture(kind === 'working' ? 'working' : 'installed');
  const journalPath = join(r.session.runDirectory, 'journal.jsonl'), j = parseGlobalMutationJournal(readFileSync(journalPath), r.session.planSha256);
  const changed = new Map<number, string>();
  for (const row of j.records) if (row.kind === 'result') {
    const file = join(r.session.runDirectory, 'state-' + j.header.runId + '-' + row.sequence + '.json'), state = JSON.parse(readFileSync(file, 'utf8'));
    const target = kind === 'working' ? state.manifest.objects.flatMap((object: any) => object.working?.rows ?? []).find((entry: any) => entry.identity.kind === 'file')
      : state.shell?.files[0]?.rows?.[0];
    if (!target) continue;
    target.identity.contentSha256 = '1'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(state) + '\n'); writeFileSync(file, bytes); changed.set(row.sequence, sha(bytes));
  }
  expect(changed.size).toBeGreaterThan(0);
  let previous = JSON.stringify(j.header) + '\n', encoded = previous;
  for (const original of j.records) {
    const row = { ...original, previousSha256: sha(Buffer.from(previous)), ...(changed.has(original.sequence) ? { stateSha256: changed.get(original.sequence) } : {}) };
    previous = JSON.stringify(row) + '\n'; encoded += previous;
  }
  writeFileSync(journalPath, encoded); const before = readdirSync(r.f.paths.root); let reached = false;
  await expect(withGlobalMigrationEvidence(r.session.runDirectory, r.session.planSha256, async () => { reached = true; })).rejects.toThrow(kind === 'working' ? 'working_content_unbound' : 'wrapper_content_unbound');
  expect(reached).toBe(false); expect(readdirSync(r.f.paths.root)).toEqual(before); expect(readFileSync(journalPath, 'utf8')).toBe(encoded);
});

it('keeps confirmed npm-after state recoverable when a bound consumer appears after child close', { timeout: 180000 }, async () => {
  const f = fixture(); let closed = false;
  const collect = async () => {
    const value = tables();
    if (closed) {
      const row = { ...value.before[0]!, pid: process.pid + 123, birth: 'after-npm-consumer', argv: [process.execPath, join(f.packageRoot, 'dist/caveat.js')] };
      value.before.push(row); value.after.push(structuredClone(row));
    }
    return value;
  };
  const session = await bindGlobalMigration(f.input, () => {}, collect), run = session.runDirectory, digest = session.planSha256;
  try {
    expect((await session.engine.preserveAll()).status).toBe('preserved');
    expect((await session.engine.createWorkingCopies()).status).toBe('working');
    const result = await session.engine.uninstallWorking(async () => {
      const receipt = await runOwnedGlobalNpm(process.execPath, ['-e', 'for(const p of process.argv.slice(1))require("node:fs").rmSync(p,{recursive:true})',
        ...session.engine.manifest().objects.map(row => join(row.directory, row.name))], run, {}, () => {}, 5000);
      closed = true; return receipt;
    });
    expect(result).toMatchObject({ status: 'stopped', recovery: 'fresh-known-only-plan-required' });
    expect(session.journal.read().status).toBe('ready');
    expect(session.journal.read().records.at(-1)).toMatchObject({ kind: 'result', step: 'npm-uninstall', outcome: 'confirmed' });
  } finally { session.close(); }
  const fresh = await planGlobalRecoveryWithCollector(run, digest, async () => tables());
  expect(fresh.status).toBe('ready');
  expect((await recoverGlobalMigration(run, digest, fresh.evidenceSha256!, () => {}, async () => tables())).status).toBe('restored');
});

it('records a known wrapper placement when a read-only runtime post-check fails', { timeout: 180000 }, async () => {
  const f = fixture(), session = await bindGlobalMigration(f.input, () => {}, async () => tables()); let calls = 0;
  try {
    await removeFixtureWorking(session);
    const shell = prepareGlobalShellInstallation(session.guard, session.journal, session.engine, session.runDirectory, f.paths.root, session.plan.shellPlan,
      async () => { if (++calls === 2) throw Object.assign(Error('fixture read-only runtime drift'), { readOnlyCheckFailed: true }); await session.engine.verifyCurrent(); },
      session.plan.baseline.node);
    expect((await shell.install()).status).toBe('stopped');
    expect(shell.snapshot().files[0]!.status).toBe('installed');
    expect(session.journal.read().status).toBe('ready');
    expect(session.journal.read().records.at(-1)).toMatchObject({ kind: 'result', outcome: 'confirmed' });
  } finally { session.close(); }
  const fresh = await planGlobalRecoveryWithCollector(session.runDirectory, session.planSha256, async () => tables());
  expect(fresh.status).toBe('ready');
  expect((await recoverGlobalMigration(session.runDirectory, session.planSha256, fresh.evidenceSha256!, () => {}, async () => tables())).status).toBe('restored');
});
