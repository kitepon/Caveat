import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindGlobalPathGuard, openGlobalPathGuard, type NativeGuardDriver } from '../src/managedGlobalGuard.js';
import { globalFilesystemNativeSpec, isWindows } from '../src/platform.js';
import { createPosixGlobalGuard } from '../src/managedPosixGuard.js';
import { createWindowsGlobalGuard } from '../src/managedWindowsGuard.js';
import { runWindowsAclPrivateTree } from '../src/privateWindowsAcl.js';
import { decodeGuardSid, isGuardTrustedOwner, verifyGuardAcl } from '../src/managedWindowsGuard.js';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-native-guard-'))); roots.push(root);
  const source = join(root, 'source'), backup = join(root, 'backup');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(backup, { mode: 0o700 });
  writeFileSync(join(source, 'leaf'), 'original bytes', { mode: 0o600 });
  if (isWindows()) runWindowsAclPrivateTree(root);
  return { root, source, backup };
}
async function nativeDriver(): Promise<NativeGuardDriver> {
  const spec = globalFilesystemNativeSpec(); return spec.windows ? createWindowsGlobalGuard() : createPosixGlobalGuard(spec);
}
function moved(result: ReturnType<Awaited<ReturnType<typeof openGlobalPathGuard>>['moveNoReplace']>) {
  expect(result.status, result.status === 'unknown' ? `${result.phase}:${result.nativeCode}` : undefined).toBe('moved');
}
describe('retained global filesystem guard', () => {
  it('reads bounded original bytes through the retained native file before and after an original move', async () => {
    const { source, backup } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const token = guard.retainTree(source, 'leaf');
      expect(guard.readRetainedFile(token)).toEqual(Buffer.from('original bytes'));
      expect(guard.moveTreeNoReplace(token, backup, 'original').status).toBe('moved');
      expect(guard.readRetainedFile(token)).toEqual(Buffer.from('original bytes'));
    } finally { guard.close(); }
  });
  it('rejects altered native read bytes instead of treating them as the retained configuration', async () => {
    const { source, backup } = fixture(), driver = await nativeDriver();
    const guard = bindGlobalPathGuard([source, backup], { ...driver, readFile() { return Buffer.from('foreign bytes'); } });
    try { expect(() => guard.readRetainedFile(guard.retainTree(source, 'leaf'))).toThrow('retained_file_changed'); }
    finally { guard.close(); }
  });
  it('reports a real sharing-violation result with its source file and close-client instruction', async () => {
    const { source, backup } = fixture(), driver = await nativeDriver();
    const guard = bindGlobalPathGuard([source, backup], { ...driver, rename() { throw Object.assign(Error('fixture busy'), { nativeCode: 32 }); } });
    try {
      const result = guard.moveNoReplace(guard.retain(source, 'leaf'), backup, 'retained');
      expect(result).toMatchObject({ status: 'unknown', nativeCode: 32, reason: 'global_guard_sharing_violation', file: join(source, 'leaf'), resolution: { instruction: expect.stringContaining('Close the AI client') } });
      expect(readFileSync(join(source, 'leaf'), 'utf8')).toBe('original bytes'); expect(existsSync(join(backup, 'retained'))).toBe(false);
    } finally { guard.close(); }
  });
  it('moves and restores the original object without replacing inode, bytes or mode', async () => {
    const { source, backup } = fixture(), original = statSync(join(source, 'leaf'), { bigint: true });
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'leaf');
      moved(guard.moveNoReplace(entry, backup, 'retained'));
      expect(existsSync(join(source, 'leaf'))).toBe(false);
      expect(readFileSync(join(backup, 'retained'), 'utf8')).toBe('original bytes');
      expect(statSync(join(backup, 'retained'), { bigint: true }).ino).toBe(original.ino);
      moved(guard.moveNoReplace(entry, source, 'leaf'));
      expect(statSync(join(source, 'leaf')).mode).toBe(Number(original.mode));
    } finally { guard.close(); }
  });
  it('refuses an occupied destination without overwriting either object', async () => {
    const { source, backup } = fixture(); writeFileSync(join(backup, 'retained'), 'other bytes', { mode: 0o600 });
    if (isWindows()) runWindowsAclPrivateTree(backup);
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'leaf');
      expect(() => guard.moveNoReplace(entry, backup, 'retained')).toThrow('global_guard_destination_exists');
      expect(readFileSync(join(source, 'leaf'), 'utf8')).toBe('original bytes');
      expect(readFileSync(join(backup, 'retained'), 'utf8')).toBe('other bytes');
    } finally { guard.close(); }
  });
  it('uses the native no-replace operation when a destination appears after the check', async () => {
    const { source, backup } = fixture(), driver = await nativeDriver();
    const guard = bindGlobalPathGuard([source, backup], { ...driver, rename(...args) {
      writeFileSync(join(backup, 'raced'), 'concurrent bytes', { mode: 0o600 }); driver.rename(...args);
    } });
    try {
      const result = guard.moveNoReplace(guard.retain(source, 'leaf'), backup, 'raced');
      expect(result.status).toBe('unknown'); expect(result.renameIssued).toBe(true); expect(result.automaticRecovery).toBe(false);
      expect('observations' in result && result.observations.source.state).toBe('present');
      expect(readFileSync(join(source, 'leaf'), 'utf8')).toBe('original bytes');
      expect(readFileSync(join(backup, 'raced'), 'utf8')).toBe('concurrent bytes');
    } finally { guard.close(); }
  });
  it('keeps a completed move after an unconfirmed readback rather than overwriting unknown state during rollback', async () => {
    const { source, backup } = fixture(), driver = await nativeDriver();
    const guard = bindGlobalPathGuard([source, backup], { ...driver, rename(...args) {
      driver.rename(...args); throw Error('private-error-details-never-public');
    } });
    try {
      const result = guard.moveNoReplace(guard.retain(source, 'leaf'), backup, 'retained');
      expect(result.status).toBe('unknown'); expect(result.automaticRecovery).toBe(false);
      expect('observations' in result && result.observations.source.state).toBe('absent');
      expect('observations' in result && result.observations.destination.state).toBe('present');
      expect(JSON.stringify(result)).not.toContain('private-error-details');
      expect(existsSync(join(source, 'leaf'))).toBe(false); expect(readFileSync(join(backup, 'retained'), 'utf8')).toBe('original bytes');
    } finally { guard.close(); }
  });
  it('rejects arbitrary names, out-of-scope directories, foreign tokens and a closed session', async () => {
    const { source, backup, root } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    const entry = guard.retain(source, 'leaf');
    try {
      expect(() => guard.retain(source, '../leaf')).toThrow('simple_name');
      expect(() => guard.retain(root, 'leaf')).toThrow('outside_scope');
      expect(() => guard.moveNoReplace({ identity: entry.identity }, backup, 'other')).toThrow('foreign_entry');
    } finally { guard.close(); }
    expect(() => guard.retain(source, 'leaf')).toThrow('closed'); guard.close();
  });
  it('pins or rejects a changed ancestor before issuing any leaf rename', async () => {
    const { root, source, backup } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'leaf');
      if (isWindows()) expect(() => renameSync(source, join(root, 'old-source'))).toThrow();
      else {
        renameSync(source, join(root, 'old-source')); mkdirSync(source, { mode: 0o700 });
        expect(() => guard.moveNoReplace(entry, backup, 'retained')).toThrow('parent');
        expect(readFileSync(join(root, 'old-source/leaf'), 'utf8')).toBe('original bytes');
      }
      expect(existsSync(join(backup, 'retained'))).toBe(false);
    } finally { guard.close(); }
  });
  it('pins or rejects a replaced source leaf rather than moving a substitute', async () => {
    const { source, backup } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'leaf');
      if (isWindows()) expect(() => renameSync(join(source, 'leaf'), join(source, 'old'))).toThrow();
      else {
        renameSync(join(source, 'leaf'), join(source, 'old')); writeFileSync(join(source, 'leaf'), 'substitute', { mode: 0o600 });
        expect(() => guard.moveNoReplace(entry, backup, 'retained')).toThrow('leaf');
        expect(readFileSync(join(source, 'leaf'), 'utf8')).toBe('substitute');
      }
      expect(existsSync(join(backup, 'retained'))).toBe(false);
    } finally { guard.close(); }
  });
  it('rejects shared hardlink leaves', async () => {
    const { source, backup } = fixture(); linkSync(join(source, 'leaf'), join(source, 'shared'));
    const guard = await openGlobalPathGuard([source, backup]);
    try { expect(() => guard.retain(source, 'leaf')).toThrow('shared_leaf'); } finally { guard.close(); }
  });
  it('allows unrelated child-count changes in a held ancestor while retaining the target leaf', async () => {
    const { root, source, backup } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'leaf'); mkdirSync(join(root, 'unrelated'), { mode: 0o700 });
      moved(guard.moveNoReplace(entry, backup, 'retained'));
    } finally { guard.close(); }
  });
  it('still refuses child-count changes inside the directory being retained as the mutation leaf', async () => {
    const { source, backup } = fixture(); mkdirSync(join(source, 'package'), { mode: 0o700 });
    if (isWindows()) runWindowsAclPrivateTree(join(source, 'package'));
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'package'); mkdirSync(join(source, 'package/changed'), { mode: 0o700 });
      expect(() => guard.moveNoReplace(entry, backup, 'package')).toThrow('changed');
      expect(existsSync(join(source, 'package/changed'))).toBe(true);
    } finally { guard.close(); }
  });
  it.skipIf(isWindows())('holds the symlink object itself and never opens or modifies its target', async () => {
    const { source, backup, root } = fixture(); symlinkSync('../outside', join(source, 'link')); writeFileSync(join(root, 'outside'), 'untouched');
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'link'); expect(entry.identity.kind).toBe('link');
      moved(guard.moveNoReplace(entry, backup, 'link'));
      expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('untouched');
    } finally { guard.close(); }
  });
  it.skipIf(isWindows())('stops on changed modes instead of repairing the leaf', async () => {
    const { source, backup } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'leaf'); chmodSync(join(source, 'leaf'), 0o400);
      expect(() => guard.moveNoReplace(entry, backup, 'leaf')).toThrow('changed');
      expect(statSync(join(source, 'leaf')).mode & 0o777).toBe(0o400);
    } finally { guard.close(); }
  });
  it.skipIf(isWindows())('retains visible native xattrs and refuses their later modification without exposing values', async () => {
    const { source, backup } = fixture(), spec = globalFilesystemNativeSpec(); if (spec.windows) throw Error('fixture_platform_mismatch');
    const koffi = await import('koffi'), library = koffi.load(spec.library);
    const tail = spec.xattrGetTail.length ? [0, 0] : [0];
    const set = library.func(`int fsetxattr(int fd, const char *name, const void *value, size_t size, ${tail.length === 2 ? 'uint32_t position, int options' : 'int flags'})`);
    const fd = openSync(join(source, 'leaf'), 'r+'), value = Buffer.from('private-xattr-value');
    try { expect(set(fd, 'user.caveat.guard', value, value.length, ...tail)).toBe(0); } finally { closeSync(fd); }
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const entry = guard.retain(source, 'leaf'), result = guard.moveNoReplace(entry, backup, 'retained');
      moved(result); expect(JSON.stringify(result)).not.toContain('private-xattr-value');
      if (result.status === 'moved') expect(result.after.securitySha256).toBe(result.before.securitySha256);
      const changed = openSync(join(backup, 'retained'), 'r+');
      try { expect(set(changed, 'user.caveat.guard', Buffer.from('changed'), 7, ...tail)).toBe(0); } finally { closeSync(changed); }
      expect(() => guard.moveNoReplace(entry, source, 'leaf')).toThrow('changed');
    } finally { guard.close(); }
  });
  it.skipIf(!isWindows())('retains original Windows alternate streams and ACL identity when moving the base object', async () => {
    const { source, backup } = fixture(); writeFileSync(join(source, 'leaf') + ':caveat-guard', 'alternate bytes');
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const result = guard.moveNoReplace(guard.retain(source, 'leaf'), backup, 'retained'); moved(result);
      expect(readFileSync(join(backup, 'retained') + ':caveat-guard', 'utf8')).toBe('alternate bytes');
      if (result.status === 'moved') expect(result.after.securitySha256).toBe(result.before.securitySha256);
    } finally { guard.close(); }
  });
});

describe('Windows native security layouts', () => {
  const sid = Buffer.from([1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]);
  const acl = (mask: number, type = 0) => {
    const bytes = Buffer.alloc(28); bytes[0] = 2; bytes.writeUInt16LE(28, 2); bytes.writeUInt16LE(1, 4);
    bytes[8] = type; bytes.writeUInt16LE(20, 10); bytes.writeUInt32LE(mask, 12); sid.copy(bytes, 16); return bytes;
  };
  it('decodes bounded SIDs and rejects truncated or unsupported layouts', () => {
    expect(decodeGuardSid(sid)).toBe('S-1-5-18');
    expect(() => decodeGuardSid(sid.subarray(0, 8))).toThrow('invalid_sid');
    expect(() => verifyGuardAcl(acl(2, 5), new Set(), true)).toThrow('unsupported_ace');
  });
  it('recognizes the fixed Windows resource-protection owner only for ancestors, never for mutation leaves', () => {
    const installer = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
    expect(isGuardTrustedOwner(installer, 'S-1-5-21-1234', false)).toBe(true);
    expect(isGuardTrustedOwner(installer, 'S-1-5-21-1234', true)).toBe(false);
    expect(isGuardTrustedOwner('S-1-5-80-1234', 'S-1-5-21-1234', false)).toBe(false);
    expect(isGuardTrustedOwner('S-1-5-21-9876', 'S-1-5-21-1234', false)).toBe(false);
  });
  it('rejects foreign writers while allowing only creation at an independently bound ancestor', () => {
    expect(() => verifyGuardAcl(acl(2), new Set(), true)).toThrow('foreign_acl_writer');
    expect(() => verifyGuardAcl(acl(2), new Set(), false)).not.toThrow();
    expect(() => verifyGuardAcl(acl(0x40), new Set(), false)).toThrow('foreign_acl_writer');
    expect(() => verifyGuardAcl(acl(0x40000000), new Set(['S-1-5-18']), true)).not.toThrow();
    expect(() => verifyGuardAcl(acl(1), new Set(['S-1-5-18']), true, 'S-1-5-21-1234')).toThrow('foreign_acl_reader');
  });
});


describe.skipIf(process.platform === 'win32')('native POSIX parent group admission', () => {
  for (const [label, mode, members, allowed] of [
    ['private group', 0o775, [], true], ['private group 0770', 0o770, [], true], ['ordinary group with another member', 0o775, ['other'], false], ['other writable', 0o777, [], false],
  ] as const) it(label, async () => {
    const f = fixture(); chmodSync(f.source, mode);
    const uid = process.geteuid!(), gid = process.getegid!();
    const driver = await createPosixGlobalGuard(globalFilesystemNativeSpec(), { user: () => 'fixture-user',
      group: () => ({ name: 'fixture-user', gid, members: [...members] }), namedGroup: () => null, primaryUsers: () => ({ uids: [uid] }) });
    if (allowed) { const guard = bindGlobalPathGuard([f.source], driver); guard.close(); }
    else {
      try { bindGlobalPathGuard([f.source], driver); throw Error('admission unexpectedly succeeded'); }
      catch (error) { expect(error).toMatchObject({ message: 'global_guard_writable_parent', diagnostic: { path: f.source,
        mode: '0' + mode.toString(8), uid: String(uid), gid: String(gid), group: 'fixture-user', remedy: expect.stringContaining('chmod') } }); }
    }
  });
});


describe.skipIf(process.platform !== 'win32')('Windows retained protected owner', () => {
  for (const [label, owner, purpose, allowed] of [
    ['Administrators protected', 'S-1-5-32-544', 'protected', true],
    ['foreign protected', 'S-1-5-21-111-222-333-444', 'protected', false],
    ['Administrators mutation', 'S-1-5-32-544', 'mutation', false],
  ] as const) it(label, async () => {
    const f = fixture(), driver = await createWindowsGlobalGuard((path, sid) => path === join(f.source, 'leaf') ? owner : sid);
    const guard = bindGlobalPathGuard([f.source, f.backup], driver);
    try {
      if (!allowed) expect(() => guard.retainTree(f.source, 'leaf', purpose)).toThrow('global_guard_foreign_owner');
      else {
        const held = guard.retainTree(f.source, 'leaf', purpose);
        expect(guard.readRetainedFile(held)).toEqual(Buffer.from('original bytes'));
        expect(() => guard.moveTreeNoReplace(held, f.backup, 'must-not-move')).toThrow('global_guard_protected_move_forbidden');
        expect(existsSync(join(f.source, 'leaf'))).toBe(true);
      }
    } finally { guard.close(); }
  });
});


describe.skipIf(process.platform === 'win32')('POSIX protected file pins', () => {
  const groups = () => ({ user: () => 'fixture-owner', group: (gid: number) => ({ name: 'fixture-owner', gid, members: [] }),
    namedGroup: () => null, primaryUsers: () => ({ uids: [process.geteuid!()] }) });
  it.each([0o664, 0o666, 0o1666])('checks protected file mode %o without sticky exemption', async mode => {
    const f = fixture(); chmodSync(join(f.source, 'leaf'), mode);
    const guard = bindGlobalPathGuard([f.source], await createPosixGlobalGuard(globalFilesystemNativeSpec(), groups()));
    try {
      if (mode === 0o664) expect(guard.readRetainedFile(guard.retainTree(f.source, 'leaf', 'protected')).toString()).toBe('original bytes');
      else expect(() => guard.retainTree(f.source, 'leaf', 'protected')).toThrow('global_guard_writable_leaf');
    } finally { guard.close(); }
  });
  it('rejects a protected file owned by another ordinary user', async () => {
    const f = fixture(), guard = bindGlobalPathGuard([f.source], await createPosixGlobalGuard(globalFilesystemNativeSpec(), groups(),
      (path, uid) => path === join(f.source, 'leaf') ? 12345 : uid));
    try { expect(() => guard.retainTree(f.source, 'leaf', 'protected')).toThrow('global_guard_foreign_leaf'); }
    finally { guard.close(); }
  });
  it('memoizes membership once per gid while checking every object mode', async () => {
    const f = fixture(); chmodSync(f.source, 0o775); chmodSync(join(f.source, 'leaf'), 0o664);
    let groupCalls = 0, primaryCalls = 0; const data = groups();
    const driver = await createPosixGlobalGuard(globalFilesystemNativeSpec(), { ...data,
      group(gid) { groupCalls++; return data.group(gid); }, primaryUsers() { primaryCalls++; return data.primaryUsers(); } });
    const parent = driver.openRoot(f.source), file = driver.openChild(parent, 'leaf', 'protected')!;
    try {
      driver.snapshot(parent); driver.snapshot(file); driver.snapshot(parent);
      chmodSync(join(f.source, 'leaf'), 0o666); expect(() => driver.snapshot(file)).toThrow('global_guard_writable_leaf');
      chmodSync(join(f.source, 'leaf'), 0o664); driver.snapshot(file);
      chmodSync(f.source, 0o777); expect(() => driver.snapshot(parent)).toThrow('global_guard_writable_parent');
      chmodSync(f.source, 0o775); driver.snapshot(parent);
      expect(groupCalls).toBe(1); expect(primaryCalls).toBe(1);
    } finally { driver.close(file); driver.close(parent); }
  });
});
