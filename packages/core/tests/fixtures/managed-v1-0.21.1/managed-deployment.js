#!/usr/bin/env node
import { createRequire as __caveat_createRequire } from 'node:module';
const require = __caveat_createRequire(import.meta.url);

// ../../packages/core/src/managedDeploymentRuntime.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join as join2, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";

// ../../packages/core/src/platform.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, isAbsolute, win32 } from "node:path";
function isWindows(platform = process.platform) {
  return platform === "win32";
}

// ../../packages/core/src/managedDeploymentRuntime.ts
var sha = (data) => createHash2("sha256").update(data).digest("hex");
var releasePattern = /^\d+\.\d+\.\d+-[a-f0-9]{20}$/;
var versionPattern = /^\d+\.\d+\.\d+$/;
var MAX_FILES = 4096;
function fail(reason) {
  throw Error(`managed_deployment_${reason}`);
}
function canonicalHome(userHome = homedir()) {
  const path = resolve(userHome);
  return existsSync(path) ? realpathSync(path) : path;
}
function managedDeploymentPaths(userHome = homedir()) {
  const root = join2(canonicalHome(userHome), ".local", "share", "caveat", "managed-v1");
  return {
    root,
    releases: join2(root, "releases"),
    entry: join2(root, "entry"),
    launcher: join2(root, "entry", "caveat.mjs"),
    runtime: join2(root, "entry", "managed-deployment.js"),
    pointer: join2(root, "active.json"),
    lock: join2(root, "installer.lock")
  };
}
function ownerStat(path, directory, options) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) fail("unsafe_path");
  if (!(options.windows ?? isWindows()) && ((s.mode & 18) !== 0 || typeof process.getuid === "function" && s.uid !== process.getuid())) fail("unsafe_owner_or_mode");
  return s;
}
function assertAncestors(options) {
  const paths = managedDeploymentPaths(options.userHome);
  const home = canonicalHome(options.userHome);
  ownerStat(home, true, options);
  let path = home;
  for (const part of relative(home, paths.root).split(sep)) {
    path = join2(path, part);
    ownerStat(path, true, options);
  }
  if (realpathSync(paths.root) !== paths.root) fail("root_redirected");
  return paths;
}
function checkReleaseMetadata(pointer, options) {
  const paths = managedDeploymentPaths(options.userHome);
  if (pointer.schema !== 1 || !releasePattern.test(pointer.release) || !/^[a-f0-9]{64}$/.test(pointer.manifestSha256)) fail("invalid_pointer");
  const releaseRoot = join2(paths.releases, pointer.release);
  ownerStat(paths.releases, true, options);
  ownerStat(releaseRoot, true, options);
  const manifestPath = join2(releaseRoot, "manifest.json");
  if (ownerStat(manifestPath, false, options).size > 1024 * 1024) fail("manifest_too_large");
  const bytes = readFileSync(manifestPath);
  if (sha(bytes) !== pointer.manifestSha256) fail("manifest_changed");
  const manifest = JSON.parse(bytes.toString());
  if (manifest.schema !== 1 || !versionPattern.test(manifest.version) || !pointer.release.startsWith(manifest.version + "-") || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) fail("invalid_manifest");
  const packageRoot = join2(releaseRoot, "package");
  ownerStat(packageRoot, true, options);
  ownerStat(join2(packageRoot, "dist"), true, options);
  const cliScriptPath = join2(packageRoot, "dist", "caveat.js");
  ownerStat(cliScriptPath, false, options);
  return { pointer, manifest, packageRoot, cliScriptPath, launcher: paths.launcher };
}
function readManagedDeployment(options = {}) {
  const paths = assertAncestors(options);
  ownerStat(paths.entry, true, options);
  ownerStat(paths.launcher, false, options);
  ownerStat(paths.runtime, false, options);
  if (ownerStat(paths.pointer, false, options).size > 1024) fail("pointer_too_large");
  const pointer = JSON.parse(readFileSync(paths.pointer, "utf8"));
  if (Object.keys(pointer).sort().join(",") !== "manifestSha256,release,schema") fail("invalid_pointer");
  return checkReleaseMetadata(pointer, options);
}
function managedRegistrationPath(cliScriptPath, options = {}) {
  const paths = managedDeploymentPaths(options.userHome);
  if (!existsSync(paths.pointer)) return cliScriptPath;
  const active = readManagedDeployment(options);
  return active.launcher;
}
var managedDeploymentInternal = { sha, fail, canonicalHome, ownerStat, assertAncestors, checkReleaseMetadata, versionPattern, releasePattern };
export {
  managedDeploymentInternal,
  managedDeploymentPaths,
  managedRegistrationPath,
  readManagedDeployment
};
//# sourceMappingURL=managed-deployment.js.map