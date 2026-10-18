#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Install the warning handler before loading any SQLite-dependent product module.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  process.stderr.write(`(${warning?.name}) ${warning?.message}\n`);
});

// Node 22.5 includes SQLite behind a startup flag. Own that requirement in the
// shipped launcher, so ordinary npm-bin/MCP/hook commands keep the public floor.
// Feature detection also covers other supported Node versions before unflagging.
const hasSqlite = Boolean(process.getBuiltinModule?.('node:sqlite'));
const flagPattern = /^--(?:no-)?experimental-sqlite(?:=|$)/;
// Node treats underscores as hyphens in option names, but retains original
// tokens in execArgv. Normalize comparisons only; forward argv/env unchanged.
const explicitFlag = process.execArgv.some((arg) => flagPattern.test(arg.replaceAll('_', '-'))) ||
  /(?:^|[\s"'])--(?:no-)?experimental-sqlite(?:$|[\s"'=])/.test((process.env.NODE_OPTIONS ?? '').replaceAll('_', '-'));

if (!hasSqlite && !explicitFlag && process.allowedNodeEnvironmentFlags.has('--experimental-sqlite')) {
  const child = spawn(process.execPath, [
    ...process.execArgv, '--experimental-sqlite', fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { stdio: 'inherit', shell: false });
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTerminate);
  const detachSignals = () => {
    process.removeListener('SIGINT', forwardInterrupt);
    process.removeListener('SIGTERM', forwardTerminate);
  };
  child.once('error', () => {
    detachSignals();
    process.stderr.write('[caveat:fatal] unable to start the SQLite-enabled runtime\n');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    detachSignals();
    if (signal) {
      // Preserve signal termination rather than turn a killed child into success.
      try { process.kill(process.pid, signal); }
      catch { process.exitCode = 1; }
    } else process.exitCode = code ?? 1;
  });
} else {
  // An explicit enable/disable is never overridden. A failed flagged child
  // reaches this branch once, so unavailable SQLite cannot create a retry loop.
  import('./index.js').catch((error) => {
    process.stderr.write('[caveat:fatal] ' + (error?.stack || error) + '\n');
    process.exit(1);
  });
}
