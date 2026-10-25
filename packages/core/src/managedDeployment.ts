import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync, chmodSync, lstatSync, readdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { isWindows } from './platform.js';
import { runWindowsAcl, runWindowsAclPrivateTree, runWindowsAclVerifyPrivateTree, runWindowsManagedRootAcl } from './privateWindowsAcl.js';
import { managedDeploymentPaths, readManagedDeployment, managedDeploymentInternal } from './managedDeploymentRuntime.js';
import type { Manifest, Pointer, FileRecord, ManagedRuntimeOptions } from './managedDeploymentRuntime.js';
export { managedDeploymentPaths, readManagedDeployment, managedRegistrationPath } from './managedDeploymentRuntime.js';

export type ManagedDeploymentOptions = ManagedRuntimeOptions & {
  entrySourceRoot?: string;
  aclTreeRunner?: typeof runWindowsAclPrivateTree;
  aclVerifyTreeRunner?: typeof runWindowsAclVerifyPrivateTree;
  recoverInvalidPointer?: boolean;
};
const { sha, fail, canonicalHome, ownerStat, assertAncestors, checkReleaseMetadata, versionPattern, releasePattern } = managedDeploymentInternal;
const MAX_FILES = 4096;
const MAX_BYTES = 128 * 1024 * 1024;
function safeRelative(file: string) {
  if (!file || isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid_manifest_path');
}
function inventory(root: string, options: ManagedRuntimeOptions, privateSource = false): FileRecord[] {
  const files: FileRecord[] = []; let bytes = 0;
  function walk(path: string) {
    const s = lstatSync(path);
    if (s.isSymbolicLink()) fail('source_link');
    // A caller-owned source below an owner-only ancestor cannot be modified
    // by another user even when npm's normal umask leaves interior group-write
    // bits. Destination files are independently sealed and verified below.
    if (privateSource && !(options.windows ?? isWindows())) {
      if (typeof process.getuid === 'function' && s.uid !== process.getuid()) fail('unsafe_owner_or_mode');
    } else ownerStat(path, s.isDirectory(), options);
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
function hasPrivateSourceAncestor(source: string, options: ManagedRuntimeOptions) {
  if (options.windows ?? isWindows()) return false;
  let path = source;
  for (;;) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('source_link');
    if (typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && (stat.mode & 0o100) !== 0) return true;
    const parent = dirname(path); if (parent === path) return false; path = parent;
  }
}
/** Seal only the newly copied payload, never the supplied package or root. */
function sealPosixCopy(root: string, options: ManagedRuntimeOptions) {
  if (options.windows ?? isWindows()) return;
  function walk(path: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('unsafe_path');
    chmodSync(path, stat.isDirectory() || (stat.mode & 0o100) !== 0 ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  }
  walk(root);
}
function verifyRoot(options: ManagedDeploymentOptions) {
  const paths = assertAncestors(options);
  if (options.windows ?? isWindows()) {
    if (options.aclRunner) options.aclRunner(paths.root, true, false);
    else runWindowsManagedRootAcl(paths.root, canonicalHome(options.userHome));
    const metadata = [paths.entry, paths.pointer].filter(path => existsSync(path));
    if (metadata.length) (options.aclVerifyTreeRunner ?? runWindowsAclVerifyPrivateTree)(metadata[0]!, metadata.slice(1));
  }
  return paths;
}
function checkRelease(pointer: Pointer, options: ManagedDeploymentOptions) {
  const checked = checkReleaseMetadata(pointer, options);
  if (options.windows ?? isWindows()) (options.aclVerifyTreeRunner ?? runWindowsAclVerifyPrivateTree)(join(managedDeploymentPaths(options.userHome).releases, pointer.release));
  if (JSON.stringify(inventory(checked.packageRoot, options)) !== JSON.stringify(checked.manifest.files)) fail('payload_changed');
  const pkg = JSON.parse(readFileSync(join(checked.packageRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'caveat-cli' || pkg.version !== checked.manifest.version || pkg.bin?.caveat !== 'dist/caveat.js') fail('invalid_package');
  return checked;
}
/** Full content and native ACL verification belongs to installer/status. */
export function verifyManagedDeployment(options: ManagedDeploymentOptions = {}) {
  verifyRoot(options);
  return checkRelease(readManagedDeployment(options).pointer, options);
}
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
  verifyRoot(options);
  for (const path of [paths.releases, paths.entry]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    ownerStat(path, true, options);
  }
  return paths;
}
function withInstallerLock<T>(options: ManagedDeploymentOptions, fn: (paths: ReturnType<typeof managedDeploymentPaths>) => T): T {
  const paths = createRoot(options);
  let fd: number;
  try { fd = openSync(paths.lock, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('installer_busy'); throw error; }
  try {
    writeFileSync(fd, JSON.stringify({ schema: 1, pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    fsyncSync(fd);
    return fn(paths);
  }
  finally { closeSync(fd); rmSync(paths.lock); }
}
type InstallerLock = { schema: 1; pid: number; startedAt: string };
function readInstallerLock(options: ManagedDeploymentOptions) {
  const paths = managedDeploymentPaths(options.userHome);
  if (!existsSync(paths.lock)) return null;
  const stat = ownerStat(paths.lock, false, options);
  if (stat.size > 1024) fail('lock_invalid');
  const bytes = readFileSync(paths.lock);
  let value: InstallerLock;
  try { value = JSON.parse(bytes.toString()) as InstallerLock; } catch { return fail('lock_invalid'); }
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'pid,schema,startedAt' || value.schema !== 1 || !Number.isInteger(value.pid) || value.pid < 1 || value.pid > 2147483647 || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) fail('lock_invalid');
  // ESRCH is the only positive proof of absence. EPERM/other errors, including
  // PID reuse, remain conservatively busy; age alone never permits removal.
  let state: 'busy' | 'stale' = 'busy';
  try { process.kill(value.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') state = 'stale'; }
  return { value, bytes, stat, state };
}
export function managedInstallerLockStatus(options: ManagedDeploymentOptions = {}) {
  const paths = managedDeploymentPaths(options.userHome);
  if (!existsSync(paths.root)) return { state: 'absent' as const };
  verifyRoot(options);
  const lock = readInstallerLock(options);
  return lock ? { state: lock.state, pid: lock.value.pid, startedAt: lock.value.startedAt } : { state: 'absent' as const };
}
/** Explicitly recover only an owner-only lock whose process no longer exists. */
export function recoverManagedInstallerLock(options: ManagedDeploymentOptions = {}) {
  const paths = verifyRoot(options), lock = readInstallerLock(options);
  if (!lock) return { removed: false };
  if (lock.state !== 'stale') fail('installer_busy');
  const current = ownerStat(paths.lock, false, options);
  if (current.dev !== lock.stat.dev || current.ino !== lock.stat.ino || !readFileSync(paths.lock).equals(lock.bytes)) fail('lock_changed');
  rmSync(paths.lock);
  return { removed: true, previousPid: lock.value.pid, startedAt: lock.value.startedAt };
}
/** Stage the caller-verified npm package; this does not edit registrations or trust. */
export function stageManagedDeployment(packageRoot: string, options: ManagedDeploymentOptions = {}) {
  const source = resolve(packageRoot);
  const sourceFiles = inventory(source, options, hasPrivateSourceAncestor(source, options));
  const entrySource = resolve(options.entrySourceRoot ?? source);
  const entryFiles = entrySource === source ? sourceFiles : inventory(entrySource, options, hasPrivateSourceAncestor(entrySource, options));
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'caveat-cli' || !versionPattern.test(pkg.version) || pkg.bin?.caveat !== 'dist/caveat.js') fail('invalid_package');
  const manifest: Manifest = { schema: 1, version: pkg.version, files: sourceFiles };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  const manifestSha256 = sha(manifestBytes), release = `${pkg.version}-${manifestSha256.slice(0, 20)}`;
  return withInstallerLock(options, paths => {
    const entrySources = [['caveat.mjs', 'stable-entry.mjs'], ['managed-deployment.js', 'managed-deployment.js']] as const;
    for (const [name, from] of entrySources) {
      const bytes = readFileSync(join(entrySource, 'dist', from));
      if (sha(bytes) !== entryFiles.find(file => file.path === `dist/${from}`)?.sha256) fail('entry_source_changed');
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
        sealPosixCopy(join(staging, 'package'), options);
        if (JSON.stringify(inventory(join(staging, 'package'), options)) !== JSON.stringify(sourceFiles)) fail('stage_copy_changed');
        writeFileSync(join(staging, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
        if (options.windows ?? isWindows()) (options.aclTreeRunner ?? runWindowsAclPrivateTree)(staging);
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
      verifyRoot(options);
      if (previousBytes ? !readFileSync(paths.pointer).equals(previousBytes) : existsSync(paths.pointer)) fail('pointer_changed');
      renameSync(temporary, paths.pointer);
    } finally { rmSync(temporary, { force: true }); }
    return { release, version: checked.manifest.version, previousRelease: previous?.release ?? null, launcher: paths.launcher };
  });
}
