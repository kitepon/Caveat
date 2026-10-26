import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { managedDeploymentPaths } from './managedDeploymentRuntime.js';

/** Only a definitely absent deployment permits instructions through PATH. */
export function usesManagedGuidance(userHome = homedir()): boolean {
  try { lstatSync(managedDeploymentPaths(userHome).root); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}
