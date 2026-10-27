// Isolated fixture only: keep detached worker stdio/lifetime unchanged.
if (process.argv.includes('runtime-errors') && process.argv.includes('report')) {
  const { appendFileSync } = require('node:fs');
  const start = Date.now(), file = process.env.CAVEAT_REPORT_FIXTURE_OBSERVER;
  const emit = event => { try { if (file) appendFileSync(file, JSON.stringify({ elapsed_ms: Date.now() - start, ...event }) + '\n'); } catch {} };
  const fs = require('node:fs'), cp = require('node:child_process');
  const fixedCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value) ? value : null;
  for (const operation of ['mkdirSync', 'lstatSync', 'statSync', 'readFileSync', 'writeFileSync', 'renameSync']) {
    const original = fs[operation];
    fs[operation] = function () {
      try { return original.apply(this, arguments); }
      catch (error) { emit({ phase: 'filesystem_failure', operation, code: fixedCode(error.code) }); throw error; }
    };
  }
  const spawn = cp.spawnSync;
  cp.spawnSync = function () {
    const began = Date.now(), result = spawn.apply(this, arguments);
    if (result.error || result.status !== 0) emit({ phase: 'child_failure', duration_ms: Date.now() - began,
      code: fixedCode(result.error?.code), status: result.status, signal: fixedCode(result.signal) });
    return result;
  };
  require('node:module').syncBuiltinESMExports();
  const write = process.stdout.write;
  process.stdout.write = function (chunk) {
    try {
      const result = JSON.parse(String(chunk));
      const fixed = value => typeof value === 'string' && /^[a-z_]+$/.test(value) ? value : null;
      emit({ phase: 'result', status: fixed(result.status), outcome: fixed(result.outcome) });
    } catch {}
    return write.apply(this, arguments);
  };
  process.once('exit', code => emit({ phase: 'exit', code }));
}
