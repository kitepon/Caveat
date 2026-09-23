import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPrivateOwnerStat, isWindowsEnv, runWindowsAcl } from '@caveat/core';

const KEY_FILE = 'typesafe.key';

export function jevKeyPath(caveatHome: string): string {
  return join(caveatHome, 'credentials', KEY_FILE);
}

function assertPrivate(path: string, directory: boolean): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('jev_credential_unsafe');
  if (isWindowsEnv(process.env)) runWindowsAcl(path, directory, false);
  else if (!isPrivateOwnerStat(info, typeof process.getuid === 'function' ? process.getuid() : undefined)) {
    throw new Error('jev_credential_unsafe');
  }
}

export function readJevKey(caveatHome: string): string {
  const directory = join(caveatHome, 'credentials');
  const path = jevKeyPath(caveatHome);
  assertPrivate(directory, true);
  assertPrivate(path, false);
  const key = readFileSync(path, 'utf8').trim();
  if (!key || /[\r\n]/u.test(key)) throw new Error('jev_credential_invalid');
  return key;
}

export function writeJevKey(caveatHome: string, value: string): void {
  const key = value.trim();
  if (!key || /[\r\n]/u.test(key)) throw new Error('jev_credential_invalid');
  const directory = join(caveatHome, 'credentials');
  const created = !existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created && isWindowsEnv(process.env)) runWindowsAcl(directory, true, true);
  assertPrivate(directory, true);
  const path = jevKeyPath(caveatHome);
  if (existsSync(path)) assertPrivate(path, false);
  const temporary = join(directory, `.typesafe-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, `${key}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (isWindowsEnv(process.env)) runWindowsAcl(temporary, false, true);
    assertPrivate(temporary, false);
    renameSync(temporary, path);
    assertPrivate(path, false);
  } finally {
    rmSync(temporary, { force: true });
  }
}
