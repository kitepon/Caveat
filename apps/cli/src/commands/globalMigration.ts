import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { executeGlobalMigration, executeGlobalRecovery, globalNpmLayout, inspectGlobalMigrationRecovery, inspectGlobalRecoveryAttempt, managedDeploymentPaths, planGlobalMigration,
  readGlobalPackageJson, readManagedDeployment, snapshotGlobalTree, type GlobalMigrationInput } from '@caveat/core';
import { resolveAgentConfigPaths } from '../installShared.js';

export type GlobalMigrationOptions = { globalRoot: string; npmCli: string; expectedPlanSha256?: string };

/** Uses normal product configuration paths, without reading repositories, auth stores or requiring host collectors. */
export function globalMigrationInput(options: GlobalMigrationOptions, userHome = homedir(), env: NodeJS.ProcessEnv = process.env): GlobalMigrationInput {
  const globalRoot = resolve(options.globalRoot), packageRoot = join(globalRoot, 'caveat-cli'), selected = readManagedDeployment({ userHome });
  const paths = managedDeploymentPaths(userHome), configs = resolveAgentConfigPaths(userHome, env);
  const candidates = [...new Set([paths.pointer, join(userHome, '.caveatrc.json'), configs.claudeMcp, join(configs.claudeDir, 'settings.json'),
    join(configs.codexHome, 'config.toml'), join(configs.codexHome, 'hooks.json'), join(configs.grokHome, 'config.toml'),
    join(configs.cursorDir, 'mcp.json'), join(configs.cursorDir, 'hooks.json')].map(file => resolve(file)))];
  const pins: { file: string; sha256: string }[] = [], protectedAbsent: string[] = [];
  for (const file of candidates) {
    try { lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; protectedAbsent.push(file); continue; }
    const tree = snapshotGlobalTree(file, { observeOnly: true, maxBytes: 1024 * 1024 });
    assert.ok(tree.length === 1 && tree[0]!.kind === 'file' && tree[0]!.sha256, 'global_cli_protected_file_invalid');
    pins.push({ file, sha256: tree[0]!.sha256! });
  }
  const pkg = readGlobalPackageJson(join(packageRoot, 'package.json'));
  assert.ok(pkg.name === 'caveat-cli' && typeof pkg.version === 'string', 'global_cli_package_invalid');
  return { binDirectory: globalNpmLayout(globalRoot).binDirectory, protectedAbsent, snapshot: {
    globalRoot, packageRoot, expectedPackageVersion: pkg.version, node: process.execPath, nodeVersion: process.version, npmAlias: resolve(options.npmCli),
    pointer: paths.pointer, expectedRelease: selected.pointer.release, protectedFiles: pins.map(row => row.file), pins,
  } };
}

export async function runGlobalMigrationCommand(mode: 'plan' | 'execute', options: GlobalMigrationOptions) {
  let sequence = 0;
  const output = (value: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ...value, sequence: ++sequence }) + '\n');
  output({ schema: 'caveat.global_migration_event.v1', phase: 'input', event: 'issued', planSha256: null, runId: null });
  try {
    const input = globalMigrationInput(options);
    if (mode === 'plan') {
      const result = await planGlobalMigration(input, event => output({ schema: 'caveat.global_migration_event.v1', ...event }));
      output({ schema: 'caveat.global_migration_plan_result.v1', status: 'ready', planSha256: result.planSha256,
        packageVersion: result.plan.baseline.packageVersion, release: input.snapshot.expectedRelease, protectedFiles: input.snapshot.protectedFiles.length,
        protectedAbsences: input.protectedAbsent!.length, filesystemWrites: 0, existingProcessOperations: 0 });
    } else {
      const result = await executeGlobalMigration(input, options.expectedPlanSha256 ?? '', event => output({ ...event }));
      output({ ...result }); if (result.status !== 'completed') process.exitCode = 1;
    }
  } catch (error) {
    output({ schema: 'caveat.global_migration_result.v1', status: 'stopped', phase: 'input-or-preflight',
      errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'),
      ...(mode === 'plan' ? { filesystemWrites: 0 } : {}), existingProcessOperations: 0 }); process.exitCode = 1;
  }
}

export async function runGlobalRecoveryInspection(runId: string, planSha256: string) {
  try {
    assert.ok(/^global-(migration|recovery)-[a-f0-9]{32}$/.test(runId), 'global_cli_run_id_invalid');
    const inspect = runId.startsWith('global-recovery-') ? inspectGlobalRecoveryAttempt : inspectGlobalMigrationRecovery;
    const result = await inspect(join(managedDeploymentPaths().root, runId), planSha256);
    process.stdout.write(JSON.stringify(result) + '\n'); if (result.status !== 'observed') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ schema: 'caveat.global_recovery_inspection.v1', status: 'stopped', reason: 'inspection_unconfirmed',
      errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'),
      filesystemWrites: 0, childProcesses: 0, executionPermission: false }) + '\n'); process.exitCode = 1;
  }
}


export async function runGlobalRecovery(runId: string, planSha256: string, evidenceSha256: string) {
  let sequence = 0, dispatched = false;
  const output = (value: Record<string, unknown>) => process.stdout.write(JSON.stringify({ ...value, sequence: ++sequence }) + '\n');
  output({ schema: 'caveat.global_recovery_event.v1', phase: 'input', event: 'issued', runId: null, planSha256: null, evidenceSha256: null });
  try {
    assert.ok(/^global-migration-[a-f0-9]{32}$/.test(runId), 'global_cli_run_id_invalid');
    dispatched = true; const result = await executeGlobalRecovery(join(managedDeploymentPaths().root, runId), planSha256, evidenceSha256, event => output({ ...event }));
    output({ ...result }); if (result.status !== 'restored') process.exitCode = 1;
  } catch (error) {
    output({ schema: 'caveat.global_recovery_result.v1', status: dispatched ? 'unknown' : 'stopped', phase: dispatched ? 'execution-or-receipt' : 'input', filesystemWrites: dispatched ? null : 0, existingProcessOperations: 0,
      errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex') }); process.exitCode = 1;
  }
}
