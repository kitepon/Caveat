import { randomBytes } from 'node:crypto';
import { existsSync, accessSync, constants, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync, chmodSync, lstatSync, readdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { isWindows } from './platform.js';
import { assertSqliteSearchCapability } from './runtimeCapabilities.js';
import { legacyEntryHashes, legacyManagedRoot } from './managedDeploymentLegacy.js';
import { runWindowsAcl, runWindowsAclPrivateTree, runWindowsAclVerifyPrivateTree, runWindowsManagedRootAcl, runWindowsManagedSourceAcl } from './privateWindowsAcl.js';
import { managedDeploymentPaths, readManagedDeployment, managedDeploymentInternal } from './managedDeploymentRuntime.js';
import type { Manifest, Pointer, FileRecord, ManagedRuntimeOptions } from './managedDeploymentRuntime.js';
export { managedDeploymentPaths, readManagedDeployment, readManagedDeploymentAtRoot, managedRegistrationPath } from './managedDeploymentRuntime.js';

export type ManagedDeploymentOptions = ManagedRuntimeOptions & {
  entrySourceRoot?: string;
  aclTreeRunner?: typeof runWindowsAclPrivateTree;
  aclVerifyTreeRunner?: typeof runWindowsAclVerifyPrivateTree;
  aclSourceRunner?: typeof runWindowsManagedSourceAcl;
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
  if (options.windows ?? isWindows()) (options.aclVerifyTreeRunner ?? runWindowsAclVerifyPrivateTree)(join(managedDeploymentPaths(options.userHome, options.root).releases, pointer.release));
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
/** Read prospective ancestors without creating directories or repairing modes. */
function inspectProspectiveRoot(options: ManagedDeploymentOptions) {
  const paths = managedDeploymentPaths(options.userHome, options.root), home = canonicalHome(options.userHome);
  const homeStat = ownerStat(home, true, options);
  const windows = options.windows ?? isWindows();
  const observations = [{ path: '.', exists: true, mode: windows ? null : (homeStat.mode & 0o777).toString(8), ownerMatches: windows ? null : homeStat.uid === process.getuid?.() }];
  let path = home, nearest = home;
  for (const part of relative(home, paths.root).split(sep)) {
    path = join(path, part);
    try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { observations.push({ path: relative(home, path), exists: false, mode: null, ownerMatches: null }); continue; } throw error; }
    const stat = ownerStat(path, true, options); nearest = path;
    observations.push({ path: relative(home, path), exists: true, mode: windows ? null : (stat.mode & 0o777).toString(8), ownerMatches: windows ? null : stat.uid === process.getuid?.() });
  }
  if (options.windows ?? isWindows()) {
    if (options.aclRunner) options.aclRunner(paths.root, true, false);
    else runWindowsManagedRootAcl(paths.root, home, true);
  } else accessSync(nearest, constants.W_OK | constants.X_OK);
  for (const existing of [paths.releases, paths.entry]) if (existsSync(existing)) ownerStat(existing, true, options);
  if (existsSync(paths.releases) && !(options.windows ?? isWindows())) accessSync(paths.releases, constants.W_OK | constants.X_OK);
  if (existsSync(paths.root)) verifyRoot(options);
  return { ...paths, observations };
}
function createRoot(options: ManagedDeploymentOptions) {
  const paths = inspectProspectiveRoot(options), home = canonicalHome(options.userHome);
  let path = home;
  for (const part of relative(home, paths.root).split(sep)) {
    path = join(path, part);
    if (!existsSync(path)) {
      mkdirSync(path, { mode: 0o700 });
      if (options.windows ?? isWindows()) (options.aclRunner ?? runWindowsAcl)(path, true, true);
    }
    ownerStat(path, true, options);
  }
  verifyRoot(options);
  for (const path of [paths.releases, paths.entry]) {
    if (!existsSync(path)) {
      mkdirSync(path, { mode: 0o700 });
      if (options.windows ?? isWindows()) (options.aclRunner ?? runWindowsAcl)(path, true, true);
    }
    ownerStat(path, true, options);
  }
  return paths;
}
function usesPublishedLegacyEntry(paths: ReturnType<typeof managedDeploymentPaths>, options: ManagedDeploymentOptions) {
  const legacy = legacyManagedRoot(canonicalHome(options.userHome));
  return paths.root === legacy && Object.entries(legacyEntryHashes).every(([name, expected]) => {
    const path = join(paths.entry, name); if (!existsSync(path)) return false;
    ownerStat(path, false, options); return sha(readFileSync(path)) === expected;
  });
}
function withInstallerLock<T>(options: ManagedDeploymentOptions, fn: (paths: ReturnType<typeof managedDeploymentPaths>) => T): T {
  const paths = createRoot(options);
  let fd: number;
  try { fd = openSync(paths.lock, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('installer_busy'); throw error; }
  let opened = true;
  try {
    writeFileSync(fd, JSON.stringify({ schema: 1, pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    fsyncSync(fd); closeSync(fd); opened = false;
    if (options.windows ?? isWindows()) (options.aclRunner ?? runWindowsAcl)(paths.lock, false, true);
    return fn(paths);
  }
  finally { if (opened) closeSync(fd); rmSync(paths.lock); }
}
type InstallerLock = { schema: 1; pid: number; startedAt: string };
function readInstallerLock(options: ManagedDeploymentOptions) {
  const paths = managedDeploymentPaths(options.userHome, options.root);
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
  const paths = managedDeploymentPaths(options.userHome, options.root);
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
const entrySources = [['caveat.mjs', 'stable-entry.mjs'], ['managed-deployment.js', 'managed-deployment.js']] as const;
function readStageSource(packageRoot: string, options: ManagedDeploymentOptions) {
  const source = resolve(packageRoot);
  const sourceFiles = inventory(source, options, hasPrivateSourceAncestor(source, options));
  const entrySource = resolve(options.entrySourceRoot ?? source);
  const entryFiles = entrySource === source ? sourceFiles : inventory(entrySource, options, hasPrivateSourceAncestor(entrySource, options));
  if (options.windows ?? isWindows()) {
    (options.aclSourceRunner ?? runWindowsManagedSourceAcl)(source);
    if (entrySource !== source) (options.aclSourceRunner ?? runWindowsManagedSourceAcl)(entrySource);
  }
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== 'caveat-cli' || !versionPattern.test(pkg.version) || pkg.bin?.caveat !== 'dist/caveat.js') fail('invalid_package');
  const assets = entrySources.map(([name, from]) => {
    const bytes = readFileSync(join(entrySource, 'dist', from));
    if (sha(bytes) !== entryFiles.find(file => file.path === `dist/${from}`)?.sha256) fail('entry_source_changed');
    return { name, bytes };
  });
  return { source, sourceFiles, pkg, assets };
}
function inspectEntryProtocol(paths: ReturnType<typeof managedDeploymentPaths>, options: ManagedDeploymentOptions, assets: ReturnType<typeof readStageSource>['assets']) {
  const keepLegacy = usesPublishedLegacyEntry(paths, options);
  for (const { name, bytes } of assets) {
    const path = join(paths.entry, name);
    if (existsSync(path)) { ownerStat(path, false, options); if (!keepLegacy && !readFileSync(path).equals(bytes)) fail('entry_upgrade_requires_migration'); }
  }
  const type = join(paths.entry, 'package.json');
  if (existsSync(type)) { ownerStat(type, false, options); if (readFileSync(type, 'utf8') !== '{"type":"module"}\n') fail('entry_package_changed'); }
  return keepLegacy;
}
/** Actual-user acceptance: read-only source, existing ancestors and protocol. */
export function preflightManagedDeployment(packageRoot: string, options: ManagedDeploymentOptions = {}) {
  const runtime = assertSqliteSearchCapability();
  const source = readStageSource(packageRoot, options), paths = inspectProspectiveRoot(options);
  const legacyEntry = inspectEntryProtocol(paths, options, source.assets);
  if (existsSync(paths.lock)) fail('installer_busy');
  if (existsSync(paths.pointer)) verifyManagedDeployment(options);
  return { status: 'ready' as const, readOnly: true, runtime, version: source.pkg.version as string, root: paths.root, launcher: paths.launcher,
    sourceFilesVerified: source.sourceFiles.length, sourceMode: options.windows ?? isWindows() ? null : (lstatSync(source.source).mode & 0o777).toString(8), sourceDigest: sha(JSON.stringify(source.sourceFiles)),
    rootExists: existsSync(paths.root), ancestors: paths.observations, nativeAclVerified: (options.windows ?? isWindows()) && !options.aclRunner && !options.aclSourceRunner, legacyEntry, stageAllowed: true, activateAllowed: true };
}
/** Stage the caller-verified npm package; this does not edit registrations or trust. */
export function stageManagedDeployment(packageRoot: string, options: ManagedDeploymentOptions = {}) {
  assertSqliteSearchCapability();
  const { source, sourceFiles, pkg, assets } = readStageSource(packageRoot, options);
  const manifest: Manifest = { schema: 1, version: pkg.version, files: sourceFiles };
  const manifestBytes = JSON.stringify(manifest) + '\n';
  const manifestSha256 = sha(manifestBytes), release = `${pkg.version}-${manifestSha256.slice(0, 20)}`;
  return withInstallerLock(options, paths => {
    const keepPublishedLegacyEntry = inspectEntryProtocol(paths, options, assets);
    for (const { name, bytes } of assets) {
      const target = join(paths.entry, name);
      if (existsSync(target)) {
        ownerStat(target, false, options);
        if (!keepPublishedLegacyEntry && !readFileSync(target).equals(bytes)) fail('entry_upgrade_requires_migration');
      } else {
        writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        if (options.windows ?? isWindows()) (options.aclRunner ?? runWindowsAcl)(target, false, true);
      }
    }
    // ESM is explicit, independent of the invoking directory/package.
    const moduleType = join(paths.entry, 'package.json');
    if (existsSync(moduleType)) {
      ownerStat(moduleType, false, options);
      if (readFileSync(moduleType, 'utf8') !== '{"type":"module"}\n') fail('entry_package_changed');
    } else {
      writeFileSync(moduleType, '{"type":"module"}\n', { flag: 'wx', mode: 0o600 });
      if (options.windows ?? isWindows()) (options.aclRunner ?? runWindowsAcl)(moduleType, false, true);
    }
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
  assertSqliteSearchCapability();
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
      if (options.windows ?? isWindows()) (options.aclRunner ?? runWindowsAcl)(temporary, false, true);
      verifyRoot(options);
      if (previousBytes ? !readFileSync(paths.pointer).equals(previousBytes) : existsSync(paths.pointer)) fail('pointer_changed');
      renameSync(temporary, paths.pointer);
    } finally { rmSync(temporary, { force: true }); }
    return { release, version: checked.manifest.version, previousRelease: previous?.release ?? null, launcher: paths.launcher };
  });
}
