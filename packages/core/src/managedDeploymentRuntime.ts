import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { isWindows } from './platform.js';
import type { runWindowsAcl } from './privateWindowsAcl.js';

export type FileRecord = { path: string; sha256: string; bytes: number };
export type Manifest = { schema: 1; version: string; files: FileRecord[] };
export type Pointer = { schema: 1; release: string; manifestSha256: string };
export type ManagedRuntimeOptions = { userHome?: string; windows?: boolean; aclRunner?: typeof runWindowsAcl };
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const releasePattern = /^\d+\.\d+\.\d+-[a-f0-9]{20}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const MAX_FILES = 4096;
function fail(reason: string): never { throw Error(`managed_deployment_${reason}`); }
function canonicalHome(userHome = homedir()) {
  const path=resolve(userHome);
  // macOS /var -> /private/var and other OS-level aliases may precede the
  // user profile. Descendants of the canonical home still reject redirects.
  return existsSync(path) ? realpathSync(path) : path;
}
export function managedDeploymentPaths(userHome = homedir()) {
  const root = join(canonicalHome(userHome), '.local', 'share', 'caveat', 'managed-v1');
  return { root, releases: join(root, 'releases'), entry: join(root, 'entry'),
    launcher: join(root, 'entry', 'caveat.mjs'), runtime: join(root, 'entry', 'managed-deployment.js'),
    pointer: join(root, 'active.json'), lock: join(root, 'installer.lock') };
}
function ownerStat(path: string, directory: boolean, options: ManagedRuntimeOptions) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) fail('unsafe_path');
  if (!(options.windows ?? isWindows()) && ((s.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && s.uid !== process.getuid()))) fail('unsafe_owner_or_mode');
  return s;
}
function assertAncestors(options: ManagedRuntimeOptions) {
  const paths = managedDeploymentPaths(options.userHome);
  const home = canonicalHome(options.userHome);
  ownerStat(home, true, options);
  let path = home;
  for (const part of relative(home, paths.root).split(sep)) {
    path = join(path, part); ownerStat(path, true, options);
  }
  if (realpathSync(paths.root) !== paths.root) fail('root_redirected');
  return paths;
}
function checkReleaseMetadata(pointer: Pointer, options: ManagedRuntimeOptions) {
  const paths = managedDeploymentPaths(options.userHome);
  if (pointer.schema !== 1 || !releasePattern.test(pointer.release) || !/^[a-f0-9]{64}$/.test(pointer.manifestSha256)) fail('invalid_pointer');
  const releaseRoot = join(paths.releases, pointer.release);
  ownerStat(paths.releases, true, options); ownerStat(releaseRoot, true, options);
  const manifestPath = join(releaseRoot, 'manifest.json');
  if (ownerStat(manifestPath, false, options).size > 1024 * 1024) fail('manifest_too_large');
  const bytes = readFileSync(manifestPath);
  if (sha(bytes) !== pointer.manifestSha256) fail('manifest_changed');
  const manifest = JSON.parse(bytes.toString()) as Manifest;
  if (manifest.schema !== 1 || !versionPattern.test(manifest.version) || !pointer.release.startsWith(manifest.version + '-') || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) fail('invalid_manifest');
  const packageRoot = join(releaseRoot, 'package');
  ownerStat(packageRoot, true, options); ownerStat(join(packageRoot, 'dist'), true, options);
  const cliScriptPath = join(packageRoot, 'dist', 'caveat.js'); ownerStat(cliScriptPath, false, options);
  return { pointer, manifest, packageRoot, cliScriptPath, launcher: paths.launcher };
}
/** Startup checks only: no process creation or package-wide content scan. */
export function readManagedDeployment(options: ManagedRuntimeOptions = {}) {
  const paths = assertAncestors(options);
  ownerStat(paths.entry, true, options); ownerStat(paths.launcher, false, options); ownerStat(paths.runtime, false, options);
  if (ownerStat(paths.pointer, false, options).size > 1024) fail('pointer_too_large');
  const pointer = JSON.parse(readFileSync(paths.pointer, 'utf8')) as Pointer;
  if (Object.keys(pointer).sort().join(',') !== 'manifestSha256,release,schema') fail('invalid_pointer');
  return checkReleaseMetadata(pointer, options);
}
/** Direct npm callers register the active stable entry when it owns this package. */
export function managedRegistrationPath(cliScriptPath: string, options: ManagedRuntimeOptions = {}) {
  const paths = managedDeploymentPaths(options.userHome);
  if (!existsSync(paths.pointer)) return cliScriptPath;
  const active = readManagedDeployment(options);
  // A managed installation explicitly selects its active release. An npm-bin
  // caller must not rewrite registrations back to its own version directory.
  return active.launcher;
}

export const managedDeploymentInternal = { sha, fail, canonicalHome, ownerStat, assertAncestors, checkReleaseMetadata, versionPattern, releasePattern };
