import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageManagedDeployment, preflightManagedDeployment, activateManagedDeployment, verifyManagedDeployment, managedInstallerLockStatus, recoverManagedInstallerLock } from '@caveat/core';

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
export function deploymentStatus() {
  const lock = managedInstallerLockStatus();
  try {
    const active = verifyManagedDeployment();
    return { status: 'ready' as const, release: active.pointer.release, version: active.manifest.version, launcher: active.launcher, payloadVerified: true, lock };
  } catch (error) {
    return { status: 'unavailable' as const, payloadVerified: false, lock, diagnostic: error instanceof SyntaxError ? 'invalid_deployment_json' : String((error as NodeJS.ErrnoException).code ?? (error as Error).message) };
  }
}
export function deploymentUnlock() { return recoverManagedInstallerLock(); }
