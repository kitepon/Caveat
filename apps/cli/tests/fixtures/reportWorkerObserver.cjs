// Isolated fixture only: keep detached worker stdio/lifetime unchanged.
if (process.argv.includes('runtime-errors') && process.argv.includes('report')) {
  const { appendFileSync } = require('node:fs');
  const start = Date.now(), file = process.env.CAVEAT_REPORT_FIXTURE_OBSERVER;
  const emit = event => { try { if (file) appendFileSync(file, JSON.stringify({ elapsed_ms: Date.now() - start, ...event }) + '\n'); } catch {} };
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
