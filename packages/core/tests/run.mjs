import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// CI runner seats share their host, so Vitest's 5s/10s defaults measured the seat instead of the product; a hung test still ends here.
const args = process.argv.slice(2);
const options = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
const defaults = [
  ...(options.some(arg => /^--(?:testTimeout|test-timeout)(?:=|$)/.test(arg)) ? [] : ['--testTimeout=60000']),
  ...(options.some(arg => /^--(?:hookTimeout|hook-timeout)(?:=|$)/.test(arg)) ? [] : ['--hookTimeout=60000']),
];
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...defaults, ...args], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
