import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Test Git children must never read or replace the runner's shared configuration. */
export function isolatedGitEnv(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, '.gitconfig');
  try { writeFileSync(file, '', { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return {
    ...Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_CONFIG/i.test(key)).map(key => [key, undefined])),
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'),
    GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1',
  };
}
