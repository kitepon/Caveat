import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// CI runner seats share their host, so Vitest's 5s/10s defaults measured the seat instead of the product; a hung test still ends here.
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', '--testTimeout=60000', '--hookTimeout=60000', ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
