import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageManagedDeployment, activateManagedDeployment, readManagedDeployment } from '@caveat/core';

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
export function deploymentStage(packageRoot?: string) {
  const installer = installerPackageRoot();
  return stageManagedDeployment(packageRoot ?? installer, { entrySourceRoot: installer });
}
export function deploymentActivate(release: string, recoverInvalidPointer = false) { return activateManagedDeployment(release, { recoverInvalidPointer }); }
export function deploymentStatus() {
  const active = readManagedDeployment();
  return { release: active.pointer.release, version: active.manifest.version, launcher: active.launcher, payloadVerified: true };
}
