import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { isWindows } from './platform.js';
import { runWindowsAcl, runWindowsAclPrivateTree, runWindowsManagedRootAcl } from './privateWindowsAcl.js';
import { managedDeploymentPaths, readManagedDeployment, managedDeploymentInternal } from './managedDeploymentRuntime.js';
import type { Manifest, Pointer, ManagedRuntimeOptions } from './managedDeploymentRuntime.js';
export { managedDeploymentPaths, readManagedDeployment, managedRegistrationPath } from './managedDeploymentRuntime.js';

export type ManagedDeploymentOptions = ManagedRuntimeOptions & {
  entrySourceRoot?: string;
  aclTreeRunner?: typeof runWindowsAclPrivateTree;
  recoverInvalidPointer?: boolean;
};
const { sha, fail, canonicalHome, ownerStat, assertAncestors, inventory, checkRelease, versionPattern, releasePattern } = managedDeploymentInternal;
function createRoot(options: ManagedDeploymentOptions) {
  const paths = managedDeploymentPaths(options.userHome);
  const home = canonicalHome(options.userHome);
  ownerStat(home, true, options);
  if (options.windows ?? isWindows()) {
    if (options.aclRunner) options.aclRunner(paths.root, true, false);
    else runWindowsManagedRootAcl(paths.root, home);
  }
  let path = home;
  for (const part of relative(home, paths.root).split(sep)) {
    path = join(path, part);
    if (!existsSync(path)) {
      mkdirSync(path, { mode: 0o700 });
      if ((options.windows ?? isWindows()) && path === paths.root) (options.aclRunner ?? runWindowsAcl)(path, true, true);
    }
    ownerStat(path, true, options);
  }
  assertAncestors(options);
  for (const path of [paths.releases, paths.entry]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    ownerStat(path, true, options);
  }
  return paths;
}
function withInstallerLock<T>(options: ManagedDeploymentOptions, fn: (paths: ReturnType<typeof managedDeploymentPaths>) => T): T {
  const paths = createRoot(options);
  let fd: number;
  try { fd = openSync(paths.lock, 'wx', 0o600); } catch { return fail('installer_busy'); }
  try { return fn(paths); }
  finally { closeSync(fd); rmSync(paths.lock); }
}
/** Stage the caller-verified npm package; this does not edit registrations or trust. */
export function stageManagedDeployment(packageRoot: string, options: ManagedDeploymentOptions = {}) {
  const source = resolve(packageRoot);
  const sourceFiles = inventory(source, options);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'caveat-cli' || !versionPattern.test(pkg.version) || pkg.bin?.caveat !== 'dist/caveat.js') fail('invalid_package');
  const manifest: Manifest = { schema: 1, version: pkg.version, files: sourceFiles };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  const manifestSha256 = sha(manifestBytes), release = `${pkg.version}-${manifestSha256.slice(0, 20)}`;
  return withInstallerLock(options, paths => {
    const entrySources = [['caveat.mjs', 'stable-entry.mjs'], ['managed-deployment.js', 'managed-deployment.js']] as const;
    for (const [name, from] of entrySources) {
      const bytes = readFileSync(join(options.entrySourceRoot ?? source, 'dist', from));
      const target = join(paths.entry, name);
      if (existsSync(target)) {
        ownerStat(target, false, options);
        if (!readFileSync(target).equals(bytes)) fail('entry_upgrade_requires_migration');
      } else writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    // ESM is explicit, independent of the invoking directory/package.
    const moduleType = join(paths.entry, 'package.json');
    if (existsSync(moduleType)) {
      ownerStat(moduleType, false, options);
      if (readFileSync(moduleType, 'utf8') !== '{"type":"module"}\n') fail('entry_package_changed');
    } else writeFileSync(moduleType, '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
    const target = join(paths.releases, release);
    if (!existsSync(target)) {
      const staging = join(paths.releases, `.stage-${process.pid}-${randomBytes(8).toString('hex')}`);
      mkdirSync(staging, { mode: 0o700 });
      try {
        cpSync(source, join(staging, 'package'), { recursive: true, dereference: false, preserveTimestamps: true });
        if (options.windows ?? isWindows()) (options.aclTreeRunner ?? runWindowsAclPrivateTree)(join(staging, 'package'));
        if (JSON.stringify(inventory(join(staging, 'package'), options)) !== JSON.stringify(sourceFiles)) fail('stage_copy_changed');
        writeFileSync(join(staging, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
        renameSync(staging, target);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
    checkRelease({ schema: 1, release, manifestSha256 }, options);
    return { release, version: pkg.version as string, manifestSha256, launcher: paths.launcher };
  });
}
/** Single same-directory rename commits a complete pointer on POSIX and Windows. */
export function activateManagedDeployment(release: string, options: ManagedDeploymentOptions = {}) {
  return withInstallerLock(options, paths => {
    if (!releasePattern.test(release)) fail('invalid_release');
    const manifestPath = join(paths.releases, release, 'manifest.json'); ownerStat(manifestPath, false, options);
    const next: Pointer = { schema: 1, release, manifestSha256: sha(readFileSync(manifestPath)) };
    const checked = checkRelease(next, options);
    let previous: Pointer | null = null;
    let previousBytes: Buffer | null = null;
    if (existsSync(paths.pointer)) {
      ownerStat(paths.pointer, false, options);
      previousBytes = readFileSync(paths.pointer);
      try {
        previous = JSON.parse(previousBytes.toString()) as Pointer;
        if (Object.keys(previous).sort().join(',') !== 'manifestSha256,release,schema') fail('invalid_pointer');
        checkRelease(previous, options);
      } catch (error) {
        if (!options.recoverInvalidPointer) throw error;
        previous = null;
        writeFileSync(join(paths.root, `.invalid-active-${randomBytes(8).toString('hex')}.json`), previousBytes, { flag: 'wx', mode: 0o600 });
      }
    }
    const temporary = join(paths.root, `.active-${process.pid}-${randomBytes(8).toString('hex')}`);
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(next) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      assertAncestors(options);
      if (previousBytes ? !readFileSync(paths.pointer).equals(previousBytes) : existsSync(paths.pointer)) fail('pointer_changed');
      renameSync(temporary, paths.pointer);
    } finally { rmSync(temporary, { force: true }); }
    return { release, version: checked.manifest.version, previousRelease: previous?.release ?? null, launcher: paths.launcher };
  });
}
