import { spawn } from 'node:child_process';
import { runtimeErrorReportDue } from '@caveat/core';

/**
 * Spawn a detached report worker when unacknowledged runtime errors are waiting
 * and the retry window has passed. Sending never happens on the hook's own
 * clock: the hook returns immediately and the worker owns the network call.
 */
export function maybeTriggerRuntimeErrorReport(): void {
  if (!runtimeErrorReportDue()) return;
  const cliScript = process.argv[1];
  if (!cliScript) throw new Error('current Caveat CLI script path is unavailable');
  const child = spawn(
    process.execPath,
    [...process.execArgv, '--disable-warning=ExperimentalWarning', cliScript, 'runtime-errors', 'report', '--json', '--background'],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
}
