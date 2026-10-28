import { findCaveatHome, readMcpSyncState, staleMcpServers } from '@caveat/core';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageManagedDeployment, preflightManagedDeployment, activateManagedDeployment, verifyManagedDeployment, managedInstallerLockStatus, recoverManagedInstallerLock, managedShellStatusCurrent, managedShellPlan, captureManagedShellManifest } from '@caveat/core';

function installerPackageRoot() {
  let path = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = resolve(path, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'caveat-cli') return path;
    const parent = dirname(path);
    if (path === parent) throw Error('managed_deployment_installer_package_missing');
    path = parent;
  }
}
export function deploymentPreflight(packageRoot?: string) {
  const installer = installerPackageRoot();
  return preflightManagedDeployment(packageRoot ?? installer, { entrySourceRoot: installer });
}
export function deploymentStage(packageRoot?: string) {
  const installer = installerPackageRoot();
  return stageManagedDeployment(packageRoot ?? installer, { entrySourceRoot: installer });
}
export function deploymentActivate(release: string, recoverInvalidPointer = false) { return activateManagedDeployment(release, { recoverInvalidPointer }); }
export async function deploymentStatus() {
  const lock = managedInstallerLockStatus();
  const shell = await managedShellStatusCurrent();
  const ownSync = readMcpSyncState(findCaveatHome(homedir()));
  try {
    const active = verifyManagedDeployment();
    const clients = await staleMcpServers(findCaveatHome(homedir()), active.manifest.version);
    return { clients, status: 'ready' as const, release: active.pointer.release, version: active.manifest.version, launcher: active.launcher, payloadVerified: true, lock, shell, ownSync };
  } catch (error) {
    return { status: 'unavailable' as const, payloadVerified: false, lock, shell, ownSync, diagnostic: error instanceof SyntaxError ? 'invalid_deployment_json' : String((error as NodeJS.ErrnoException).code ?? (error as Error).message) };
  }
}
export function deploymentUnlock() { return recoverManagedInstallerLock(); }

export function deploymentShellPlan(node: string, binDir: string) { return managedShellPlan(node, binDir); }
export function deploymentShellManifest(node: string, binDir: string) { return captureManagedShellManifest(deploymentShellPlan(node, binDir)); }
