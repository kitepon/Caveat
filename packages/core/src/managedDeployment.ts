import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, cpSync, realpathSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { isWindows } from './platform.js';
import { runWindowsAcl, runWindowsAclPrivateTree, runWindowsManagedRootAcl } from './privateWindowsAcl.js';

type FileRecord = { path: string; sha256: string; bytes: number };
type Manifest = { schema: 1; version: string; files: FileRecord[] };
type Pointer = { schema: 1; release: string; manifestSha256: string };
export type ManagedDeploymentOptions = {
  userHome?: string;
  entrySourceRoot?: string;
  windows?: boolean;
  aclRunner?: typeof runWindowsAcl;
  aclTreeRunner?: typeof runWindowsAclPrivateTree;
  recoverInvalidPointer?: boolean;
};
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const releasePattern = /^\d+\.\d+\.\d+-[a-f0-9]{20}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const MAX_FILES = 4096;
const MAX_BYTES = 128 * 1024 * 1024;
function fail(reason: string): never { throw Error(`managed_deployment_${reason}`); }
function windowsRootCheck(root: string, home: string, options: ManagedDeploymentOptions) {
  if (options.aclRunner) options.aclRunner(root, true, false);
  else runWindowsManagedRootAcl(root, home);
}
export function managedDeploymentPaths(userHome = homedir()) {
  const root = join(resolve(userHome), '.local', 'share', 'caveat', 'managed-v1');
  return { root, releases: join(root, 'releases'), entry: join(root, 'entry'),
    launcher: join(root, 'entry', 'caveat.mjs'), runtime: join(root, 'entry', 'managed-deployment.js'),
    pointer: join(root, 'active.json'), lock: join(root, 'installer.lock') };
}
function ownerStat(path: string, directory: boolean, options: ManagedDeploymentOptions) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) fail('unsafe_path');
  if (!(options.windows ?? isWindows()) && ((s.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && s.uid !== process.getuid()))) fail('unsafe_owner_or_mode');
  return s;
}
function assertAncestors(options: ManagedDeploymentOptions) {
  const paths = managedDeploymentPaths(options.userHome);
  const home = resolve(options.userHome ?? homedir());
  ownerStat(home, true, options);
  let path = home;
  for (const part of relative(home, paths.root).split(sep)) {
    path = join(path, part); ownerStat(path, true, options);
  }
  if (realpathSync(paths.root) !== paths.root) fail('root_redirected');
  if (options.windows ?? isWindows()) windowsRootCheck(paths.root, home, options);
  return paths;
}
function createRoot(options: ManagedDeploymentOptions) {
  const paths = managedDeploymentPaths(options.userHome);
  const home = resolve(options.userHome ?? homedir());
  ownerStat(home, true, options);
  if (options.windows ?? isWindows()) windowsRootCheck(paths.root, home, options);
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
function safeRelative(file: string) {
  if (!file || isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid_manifest_path');
}
function inventory(root: string, options: ManagedDeploymentOptions): FileRecord[] {
  const files: FileRecord[] = []; let bytes = 0;
  function walk(path: string) {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) fail('source_link');
    ownerStat(path, s.isDirectory(), options);
    if (s.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
    else {
      if (!s.isFile() || s.nlink !== 1) fail('source_not_regular');
      bytes += s.size;
      if (files.length >= MAX_FILES || bytes > MAX_BYTES) fail('payload_too_large');
      const name = relative(root, path).split(sep).join('/'); safeRelative(name);
      files.push({ path: name, sha256: sha(readFileSync(path)), bytes: s.size });
    }
  }
  walk(root); return files;
}
function checkRelease(pointer: Pointer, options: ManagedDeploymentOptions) {
  const paths = managedDeploymentPaths(options.userHome);
  if (pointer.schema !== 1 || !releasePattern.test(pointer.release) || !/^[a-f0-9]{64}$/.test(pointer.manifestSha256)) fail('invalid_pointer');
  const releaseRoot = join(paths.releases, pointer.release);
  ownerStat(paths.releases, true, options); ownerStat(releaseRoot, true, options);
  const manifestPath = join(releaseRoot, 'manifest.json'); ownerStat(manifestPath, false, options);
  const bytes = readFileSync(manifestPath);
  if (sha(bytes) !== pointer.manifestSha256) fail('manifest_changed');
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (manifest.schema !== 1 || !versionPattern.test(manifest.version) || !pointer.release.startsWith(manifest.version + '-') || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) fail('invalid_manifest');
  const packageRoot = join(releaseRoot, 'package');
  const actual = inventory(packageRoot, options);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) fail('payload_changed');
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'caveat-cli' || pkg.version !== manifest.version || pkg.bin?.caveat !== 'dist/caveat.js') fail('invalid_package');
  const cliScriptPath = join(packageRoot, 'dist', 'caveat.js'); ownerStat(cliScriptPath, false, options);
  return { pointer, manifest, packageRoot, cliScriptPath, launcher: paths.launcher };
}
export function readManagedDeployment(options: ManagedDeploymentOptions = {}) {
  const paths = assertAncestors(options);
  ownerStat(paths.entry, true, options); ownerStat(paths.launcher, false, options); ownerStat(paths.runtime, false, options);
  ownerStat(paths.pointer, false, options);
  const pointer = JSON.parse(readFileSync(paths.pointer, 'utf8')) as Pointer;
  if (Object.keys(pointer).sort().join(',') !== 'manifestSha256,release,schema') fail('invalid_pointer');
  return checkRelease(pointer, options);
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
/** Direct npm callers register the active stable entry when it owns this package. */
export function managedRegistrationPath(cliScriptPath: string, options: ManagedDeploymentOptions = {}) {
  const paths = managedDeploymentPaths(options.userHome);
  if (!existsSync(paths.pointer)) return cliScriptPath;
  const active = readManagedDeployment(options);
  // A managed installation explicitly selects its active release. An npm-bin
  // caller must not rewrite registrations back to its own version directory.
  return active.launcher;
}
