import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isWindows } from '../src/platform.js';
import { readGlobalPackageJson, snapshotGlobalPackage, snapshotGlobalTree, type GlobalPackageSnapshotInput } from '../src/managedGlobalSnapshot.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caveat-global-snapshot-')); roots.push(root);
  const globalRoot = join(root, 'global'), packageRoot = join(globalRoot, 'caveat-cli');
  mkdirSync(join(packageRoot, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '1.2.3', dependencies: { dep: '1' } }));
  writeFileSync(join(packageRoot, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', version: '1' }));
  const pointer = join(root, 'active.json'), npmAlias = join(root, 'npm/bin/npm-cli.js');
  writeFileSync(pointer, JSON.stringify({ release: 'fixture-release' }));
  mkdirSync(dirname(npmAlias), { recursive: true });
  writeFileSync(npmAlias, 'fixture npm source, never executed');
  writeFileSync(join(root, 'npm/package.json'), JSON.stringify({ name: 'npm', version: 'fixture' }));
  const input: GlobalPackageSnapshotInput = { packageRoot, globalRoot, expectedPackageVersion: '1.2.3',
    pointer, expectedRelease: 'fixture-release', npmAlias, node: process.execPath, nodeVersion: process.version,
    protectedFiles: [pointer], pins: [{ file: pointer, sha256: createHash('sha256').update(readFileSync(pointer)).digest('hex') }] };
  return { root, input };
}

describe('global package snapshot', () => {
  it('captures internal closure without executing npm, mutating files, or granting write permission', () => {
    const { root, input } = fixture(), before = snapshotGlobalTree(root);
    const result = snapshotGlobalPackage(input);
    expect(result.reachableManifests).toBe(2);
    expect(result.npmManagement.absent).toBe(true);
    expect(result.childProcesses).toBe(0);
    expect(result.filesystemWrites).toBe(0);
    expect(result.processAssessment).toBe('not-performed');
    expect(result.writePermission).toBe(false);
    expect(snapshotGlobalTree(root)).toEqual(before);
  });
  it('stops on a dependency that would have to resolve outside the retained package', () => {
    const { root, input } = fixture();
    rmSync(join(input.packageRoot, 'node_modules/dep'), { recursive: true });
    const before = snapshotGlobalTree(root);
    expect(() => snapshotGlobalPackage(input)).toThrow('dependency_outside_retained_package');
    expect(snapshotGlobalTree(root)).toEqual(before);
  });
  it('compares canonical dependency boundaries when an ancestor directory is an alias', () => {
    const { root, input } = fixture(), alias = join(root, 'parent-alias');
    symlinkSync(root, alias, isWindows() ? 'junction' : 'dir');
    const result = snapshotGlobalPackage({ ...input, globalRoot: join(alias, 'global'), packageRoot: join(alias, 'global/caveat-cli') });
    expect(result.reachableManifests).toBe(2);
    expect(result.writePermission).toBe(false);
  });
  it('keeps external dependency redirects rejected', () => {
    const { root, input } = fixture(), dep = join(input.packageRoot, 'node_modules/dep'), outside = join(root, 'external-dep');
    mkdirSync(outside); writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'dep', version: '1' }));
    rmSync(dep, { recursive: true });
    symlinkSync(outside, dep, isWindows() ? 'junction' : 'dir');
    expect(() => snapshotGlobalPackage(input)).toThrow('external_or_absolute_link');
  });
  it('rejects a declared peer that would resolve outside the retained package', () => {
    const { input } = fixture();
    writeFileSync(join(input.packageRoot, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '1.2.3', peerDependencies: { outside: '*' } }));
    mkdirSync(join(input.globalRoot, 'outside')); writeFileSync(join(input.globalRoot, 'outside/package.json'), '{"name":"outside","version":"1.0.0"}');
    expect(() => snapshotGlobalPackage(input)).toThrow('dependency_outside_retained_package');
  });
  it('rejects dependency traversal names', () => {
    const { input } = fixture();
    writeFileSync(join(input.packageRoot, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '1.2.3', dependencies: { '../escape': '1' } }));
    expect(() => snapshotGlobalPackage(input)).toThrow('unsafe_dependency_name');
  });
  it('refuses changed protected deployment pins and runtime binding', () => {
    const { input } = fixture();
    expect(() => snapshotGlobalPackage({ ...input, nodeVersion: 'v0' })).toThrow('runtime_version_changed');
    appendFileSync(input.pointer, ' ');
    expect(() => snapshotGlobalPackage(input)).toThrow('protected_pin_changed');
  });
  it('observes hardlinks and leaves the mutation snapshot refusal intact', () => {
    const { root, input } = fixture(), origin = join(root, 'outside-link');
    writeFileSync(origin, 'owned fixture');
    linkSync(origin, join(input.packageRoot, 'shared'));
    expect(() => snapshotGlobalTree(input.packageRoot)).toThrow('nonregular_or_shared_file');
    const before = snapshotGlobalTree(root, { observeOnly: true });
    const result = snapshotGlobalPackage(input);
    expect(result.packageTree.find(row => row.relativePath === 'shared')?.nlink).toBe('2');
    expect(result.writePermission).toBe(false);
    expect(snapshotGlobalTree(root, { observeOnly: true })).toEqual(before);
  });
  it('allows required regular JSON with a shared inode in observation only', () => {
    const { root, input } = fixture(), required = join(input.packageRoot, 'package.json');
    linkSync(required, join(root, 'manifest-hardlink'));
    expect(snapshotGlobalPackage(input).packageVersion).toBe('1.2.3');
    expect(() => snapshotGlobalTree(input.packageRoot)).toThrow('nonregular_or_shared_file');
  });
  it.each(['package', 'dependency', 'npm'])('rejects nonregular required %s JSON before reading it', kind => {
    const { root, input } = fixture();
    const target = kind === 'package' ? join(input.packageRoot, 'package.json')
      : kind === 'dependency' ? join(input.packageRoot, 'node_modules/dep/package.json') : join(root, 'npm/package.json');
    rmSync(target); mkdirSync(target);
    expect(() => snapshotGlobalPackage(input)).toThrow('required_file_nonregular');
  });
  it('bounds required JSON bytes before parsing and rejects arrays', () => {
    const { root } = fixture(), file = join(root, 'json');
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    expect(() => readGlobalPackageJson(file)).toThrow('required_file_oversized');
    writeFileSync(file, '[]');
    expect(() => readGlobalPackageJson(file)).toThrow('package_json_object_required');
  });
  it('bounds tree contents before reading oversized bytes', () => {
    const { input } = fixture();
    expect(() => snapshotGlobalTree(input.packageRoot, { maxBytes: 1 })).toThrow('tree_byte_bound');
  });
  it.skipIf(isWindows())('observes an incidental FIFO without opening it and rejects required FIFO JSON', () => {
    const { input } = fixture(), fifo = join(input.packageRoot, 'incidental-fifo');
    expect(spawnSync('mkfifo', [fifo], { timeout: 2000 }).status).toBe(0);
    expect(snapshotGlobalPackage(input).packageTree.find(row => row.relativePath === 'incidental-fifo')?.kind).toBe('special');
    expect(() => snapshotGlobalTree(input.packageRoot)).toThrow('nonregular_or_shared_file');
    const required = join(input.packageRoot, 'package.json'); rmSync(required);
    expect(spawnSync('mkfifo', [required], { timeout: 2000 }).status).toBe(0);
    expect(() => readGlobalPackageJson(required)).toThrow('required_file_nonregular');
  });
});
