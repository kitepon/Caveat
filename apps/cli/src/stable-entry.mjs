#!/usr/bin/env node
import { dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManagedDeploymentAtRoot } from './managed-deployment.js';

// This v1 entry is version independent. Installer updates replace active.json,
// never this command's definition. Keep argv[1] stable through the product import.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const active = readManagedDeploymentAtRoot(root);
  // File identity handles drive-case/8.3/extended Windows spellings without
  // accepting a symlink or changing the original stable argv registration.
  const invoked = lstatSync(process.argv[1], { bigint: true });
  const expected = lstatSync(active.launcher, { bigint: true });
  if (invoked.isSymbolicLink() || invoked.dev !== expected.dev || invoked.ino !== expected.ino) throw Error('managed_entry_identity_mismatch');
  await import(pathToFileURL(active.cliScriptPath).href);
} catch (error) {
  // Keep the concrete refusal diagnostic on stderr; never print a malformed
  // pointer's JSON contents through JSON.parse's SyntaxError excerpt.
  const reason = error instanceof SyntaxError ? 'invalid_deployment_json'
    : String(error?.code ?? error?.message ?? 'unknown_deployment_error').replace(/\s+/g, ' ').slice(0, 600);
  process.stderr.write(`[caveat:fatal] managed deployment is unavailable (${reason}); run caveat deployment status or activate a verified release\n`);
  process.exitCode = 1;
}
