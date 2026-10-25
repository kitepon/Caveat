// Published 0.21.1 compatibility only. New deployments use the private home root.
import { lstatSync } from 'node:fs';
function existsSync(path: string) { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
import { join, dirname, basename } from 'node:path';
export const legacyEntryHashes = {
  'caveat.mjs': '6e39713485eec74d8348f9a20d6b720c8a47ea5b7c485348953ca96031f284d8',
  'managed-deployment.js': '553762cc5e180c0da3ef856150530e9b7ba225ed0a6537afd1fd6e07aceab738',
};
export const legacyManagedRoot = (home: string) => join(home, '.local', 'share', 'caveat', 'managed-v1');
export function legacyHomeFromRoot(root: string): string | undefined {
  const parent = dirname(root);
  return basename(root) === 'managed-v1' && basename(parent) === 'caveat' && basename(dirname(parent)) === 'share' && basename(dirname(dirname(parent))) === '.local'
    ? dirname(dirname(dirname(parent))) : undefined;
}
/** Selection never changes the safety checks or replaces an existing reader. */
export function selectExistingDeploymentRoot(home: string, modern: string) {
  const legacy = legacyManagedRoot(home);
  const modernActive = existsSync(join(modern, 'active.json')), legacyActive = existsSync(join(legacy, 'active.json'));
  if (modernActive && legacyActive) throw Error('managed_deployment_multiple_active_roots');
  if (modernActive) return modern;
  if (legacyActive) return legacy;
  const modernExists = existsSync(modern), legacyExists = existsSync(legacy);
  if (modernExists && legacyExists) throw Error('managed_deployment_multiple_staging_roots');
  return legacyExists ? legacy : modern;
}
