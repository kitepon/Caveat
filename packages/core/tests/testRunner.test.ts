import { expect, it } from 'vitest';
import { parseCLI } from 'vitest/node';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Capture the runner's child arguments, then validate them with the installed Vitest parser.
const capture = `data:text/javascript,${encodeURIComponent(`
  import childProcess from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  childProcess.spawnSync = (_command, args) => {
    process.stdout.write(JSON.stringify(args));
    return { status: 0 };
  };
  syncBuiltinESMExports();
`)}`;

it('core and CLI test entries retain defaults and accept caller timeout overrides', () => {
  for (const directory of ['../', '../../../apps/cli/']) {
    const cwd = new URL(directory, import.meta.url);
    const { scripts } = JSON.parse(readFileSync(new URL('package.json', cwd), 'utf8'));
    const runner = scripts.test.split(' ')[1];
    const cases: [string[], number, number][] = [
      [[], 60000, 60000],
      [['--testTimeout=120000'], 120000, 60000],
      [['--hookTimeout', '120000'], 60000, 120000],
      [['--test-timeout', '120000', '--hook-timeout=90000'], 120000, 90000],
      [['--testTimeout', '120000', '--hookTimeout=90000'], 120000, 90000],
      [['--test-timeout=120000', '--hook-timeout', '90000'], 120000, 90000],
      [['--', '--testTimeout=120000', '--hook-timeout', '90000'], 60000, 60000],
    ];
    for (const [args, testTimeout, hookTimeout] of cases) {
      const result = spawnSync(process.execPath, ['--import', capture, runner, ...args], {
        cwd: fileURLToPath(cwd), encoding: 'utf8', timeout: 15000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const childArgs = JSON.parse(result.stdout);
      expect(childArgs.slice(childArgs.length - args.length)).toEqual(args);
      const { options } = parseCLI(['vitest', ...childArgs.slice(1)]);
      expect(options).toMatchObject({ testTimeout, hookTimeout });
    }
  }
});
