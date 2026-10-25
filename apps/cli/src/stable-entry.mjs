#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManagedDeployment } from './managed-deployment.js';

// This v1 entry is version independent. Installer updates replace active.json,
// never this command's definition. Keep argv[1] stable through the product import.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const userHome = dirname(dirname(dirname(dirname(root))));
try {
  const active = readManagedDeployment({ userHome });
  if (process.argv[1] !== fileURLToPath(import.meta.url)) throw Error('managed_entry_identity_mismatch');
  await import(pathToFileURL(active.cliScriptPath).href);
} catch (error) {
  // Keep the concrete refusal diagnostic on stderr; never print a malformed
  // pointer's JSON contents through JSON.parse's SyntaxError excerpt.
  const reason = error instanceof SyntaxError ? 'invalid_deployment_json'
    : String(error?.code ?? error?.message ?? 'unknown_deployment_error').replace(/\s+/g, ' ').slice(0, 600);
  process.stderr.write(`[caveat:fatal] managed deployment is unavailable (${reason}); run caveat deployment status or activate a verified release\n`);
  process.exitCode = 1;
}
