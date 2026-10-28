import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readGlobalPackageJson } from '@caveat/core';
import { planRegistrationMigration, executeRegistrationMigration, planRegistrationRecovery, executeRegistrationRecovery,
  inspectRegistrationJournal, type RegistrationInput } from '../registrationMigration.js';
export type RegistrationOptions = { observation: string; proposal: string; nodeVersion?: string; expectedPlanSha256?: string; clientsClosed?: boolean };
const errorSha = (error: unknown) => createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex');
export async function runRegistrationMigration(mode: 'plan' | 'execute', options: RegistrationOptions) {
  let sequence = 0;
  const output = (value: object) => process.stdout.write(JSON.stringify({ schema: 'caveat.registration_event.v1', ...value, sequence: ++sequence }) + '\n');
  output({ phase: 'input', event: 'issued', runId: null });
  try {
    const input: RegistrationInput = { userHome: homedir(), nodeVersion: options.nodeVersion ?? process.version, clientsClosed: options.clientsClosed, source: {
      observation: readGlobalPackageJson(options.observation), proposal: readGlobalPackageJson(options.proposal),
    } };
    const result = mode === 'plan' ? await planRegistrationMigration(input, output)
      : await executeRegistrationMigration(input, options.expectedPlanSha256 ?? '', output);
    output({ ...result, schema: 'caveat.registration_result.v1' });
    if (result.status !== (mode === 'plan' ? 'ready' : 'completed')) process.exitCode = 1;
  } catch (error) {
    output({ schema: 'caveat.registration_result.v1', status: 'stopped', phase: 'input-or-admission', runId: null, errorSha256: errorSha(error), processAssessment: (error as { preflight?: unknown })?.preflight ?? null, filesystemWrites: 0, existingProcessOperations: 0 });
    process.exitCode = 1;
  }
}
export async function runRegistrationRecovery(mode: 'plan' | 'execute' | 'inspect', run: string, planSha256: string, evidenceSha256?: string, clientsClosed = false) {
  let sequence = 0;
  const output = (value: object) => process.stdout.write(JSON.stringify({ schema: 'caveat.registration_recovery_event.v1', ...value, sequence: ++sequence }) + '\n');
  output({ phase: 'input', event: 'issued', runId: null });
  try {
    const result = mode === 'inspect' ? await inspectRegistrationJournal(homedir(), run, planSha256)
      : mode === 'plan' ? await planRegistrationRecovery(homedir(), run, planSha256, output)
      : await executeRegistrationRecovery(homedir(), run, planSha256, evidenceSha256 ?? '', output, undefined, clientsClosed);
    output(result);
    if (!['observed', 'ready', 'already-original', 'restored'].includes(result.status)) process.exitCode = 1;
  } catch (error) {
    output({ schema: 'caveat.registration_recovery_result.v1', status: 'stopped', errorSha256: errorSha(error),
      currentObjects: 'not-assessed', executionPermission: false, filesystemWrites: 0, existingProcessOperations: 0 }); process.exitCode = 1;
  }
}
