import { it, expect } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPosixGlobalGuard, verifyPosixAccessAcl } from '../src/managedPosixGuard.js';
import { globalFilesystemNativeSpec } from '../src/platform.js';
it.skipIf(process.platform !== 'linux')('rejects a named foreign ACL writer hidden by the private-group mode mask', async context => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-acl-proof-'))), file = join(dir, 'setting');
  let driver: Awaited<ReturnType<typeof createPosixGlobalGuard>> | undefined, parent: object | undefined, pin: object | undefined;
  try {
    writeFileSync(file, '{}', { mode: 0o600 });
    const k = await import('koffi'), lib = k.load('libc.so.6');
    const set = lib.func('int setxattr(const char *path, const char *name, const void *value, size_t size, int flags)');
    const acl = Buffer.alloc(44); acl.writeUInt32LE(2);
    for (const [index, [tag, perm, id]] of [[1, 6, 0xffffffff], [2, 2, process.getuid!() + 1], [4, 4, 0xffffffff], [16, 6, 0xffffffff], [32, 4, 0xffffffff]].entries()) {
      acl.writeUInt16LE(tag!, 4 + index * 8); acl.writeUInt16LE(perm!, 6 + index * 8); acl.writeUInt32LE(id!, 8 + index * 8);
    }
    const setResult = set(file, 'system.posix_acl_access', acl, acl.length, 0);
    if (setResult !== 0 && [45, 95].includes(k.errno())) context.skip();
    expect(setResult).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o664);
    driver = await createPosixGlobalGuard(globalFilesystemNativeSpec(), { user: () => 'fixture-user', group: gid => ({ name: 'fixture-user', gid, members: [] }), namedGroup: () => null, primaryUsers: () => ({ uids: [process.getuid!()] }) });
    parent = driver.openRoot(dir); pin = driver.openChild(parent, 'setting', 'protected')!;
    expect(() => driver!.snapshot(pin!)).toThrow('global_guard_extended_acl_unclassified');
  } finally { if (pin) driver?.close(pin); if (parent) driver?.close(parent); rmSync(dir, { recursive: true, force: true }); }
});

function bytes(entries: number[][]) {
  const value = Buffer.alloc(4 + entries.length * 8); value.writeUInt32LE(2);
  entries.forEach(([tag, perm, id = 0xffffffff], index) => { value.writeUInt16LE(tag!, 4 + index * 8); value.writeUInt16LE(perm!, 6 + index * 8); value.writeUInt32LE(id, 8 + index * 8); });
  return value;
}
it.each([2, 8])('rejects named ACL tag %s with write permission', tag => {
  try { verifyPosixAccessAcl(bytes([[tag, 2, 42]]), '/fixture/path'); throw Error('accepted'); }
  catch (error) { expect(error).toMatchObject({ message: 'global_guard_extended_acl_unclassified', diagnostic: { path: '/fixture/path', entry: { tag, id: 42 } } }); }
});
it('permits mode-controlled entries and read-only named entries', () => {
  expect(() => verifyPosixAccessAcl(bytes([[1, 7], [4, 7], [16, 7], [32, 4], [2, 4, 42], [8, 4, 43]]), '/fixture')).not.toThrow();
});
it.each([Buffer.alloc(3), Buffer.alloc(5), Buffer.alloc(12)])('rejects malformed access ACL bytes', value => {
  expect(() => verifyPosixAccessAcl(value, '/fixture')).toThrow('global_guard_extended_acl_unclassified');
});

it.skipIf(process.platform !== 'linux')('rejects a setfacl named writer on an otherwise accepted 0775 private directory', async context => {
  const tool = spawnSync('setfacl', ['--version']); if ((tool.error as NodeJS.ErrnoException)?.code === 'ENOENT') context.skip();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-setfacl-proof-'))); chmodSync(dir, 0o775);
  const driver = await createPosixGlobalGuard(globalFilesystemNativeSpec(), { user: () => 'fixture-user', group: gid => ({ name: 'fixture-user', gid, members: [] }), namedGroup: () => null, primaryUsers: () => ({ uids: [process.getuid!()] }) });
  const parent = driver.openRoot(dir);
  try {
    expect(() => driver.snapshot(parent)).not.toThrow();
    const added = spawnSync('setfacl', ['-m', 'u:nobody:rwx', dir], { encoding: 'utf8' });
    if (/not supported/i.test(added.stderr)) context.skip();
    expect(added.status, added.stderr).toBe(0); expect(statSync(dir).mode & 0o777).toBe(0o775);
    expect(() => driver.snapshot(parent)).toThrow('global_guard_extended_acl_unclassified');
  } finally { driver.close(parent); rmSync(dir, { recursive: true, force: true }); }
});
