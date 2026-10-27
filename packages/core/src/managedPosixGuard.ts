import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { GlobalGuardIdentity, NativeGuardDriver } from './managedGlobalGuard.js';
type Spec = { library: string | null; closeOnExec: number; linkOpen: number; loopError: number; rename: string; noReplace: number;
  xattrListTail: number[]; xattrGetTail: number[]; linkAttributesViaProc: boolean; aclType?: number };
type Ref = { fd: number; mutation?: boolean; parentOnly?: boolean; parent?: Ref; name?: string };

export async function createPosixGlobalGuard(spec: Spec): Promise<NativeGuardDriver> {
  const koffi = await import('koffi'), lib = koffi.load(spec.library);
  const open = lib.func('int open(const char *path, int flags)');
  const openat = lib.func('int openat(int dirfd, const char *path, int flags)');
  const rename = lib.func(`int ${spec.rename}(int fromfd, const char *from, int tofd, const char *to, uint32_t flags)`);
  const list = lib.func(`intptr_t flistxattr(int fd, _Out_ void *buffer, size_t size${spec.xattrListTail.length ? ', int options' : ''})`);
  const get = lib.func(`intptr_t fgetxattr(int fd, const char *name, _Out_ void *buffer, size_t size${spec.xattrGetTail.length ? ', uint32_t position, int options' : ''})`);
  const linkList = spec.linkAttributesViaProc ? lib.func('intptr_t llistxattr(const char *path, _Out_ void *buffer, size_t size)') : null;
  const linkGet = spec.linkAttributesViaProc ? lib.func('intptr_t lgetxattr(const char *path, const char *name, _Out_ void *buffer, size_t size)') : null;
  const aclGet = spec.aclType === undefined ? null : lib.func('void *acl_get_fd_np(int fd, int type)');
  const aclText = aclGet ? lib.func('void *acl_to_text(void *acl, _Out_ intptr_t *length)') : null;
  const aclFree = aclGet ? lib.func('int acl_free(void *value)') : null;
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | spec.closeOnExec;
  const attributes = (ref: Ref, symbolic: boolean) => {
    const path = symbolic && spec.linkAttributesViaProc ? `/proc/self/fd/${ref.parent!.fd}/${ref.name!}` : null;
    const readNames = (buffer: Buffer | null, size: number) => Number(path ? linkList!(path, buffer, size) : list(ref.fd, buffer, size, ...spec.xattrListTail));
    const capacity = readNames(null, 0); assert.ok(capacity >= 0 && capacity <= 65536, 'global_guard_xattr_names_unavailable');
    const buffer = Buffer.alloc(capacity || 1), length = readNames(buffer, capacity);
    assert.ok(length >= 0 && length <= capacity, 'global_guard_xattr_names_changed');
    const names = length ? new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, length)).split('\0') : [];
    if (length) assert.equal(names.pop(), '', 'global_guard_invalid_xattr_names');
    assert.ok(names.length <= 1024 && new Set(names).size === names.length && names.every(name => name.length > 0), 'global_guard_invalid_xattr_names');
    const values: { name: string; bytes: number; sha256: string }[] = []; let total = 0;
    for (const name of names.sort()) {
      const readValue = (target: Buffer | null, size: number) => Number(path ? linkGet!(path, name, target, size) : get(ref.fd, name, target, size, ...spec.xattrGetTail));
      const size = readValue(null, 0); assert.ok(size >= 0 && size <= 16 * 1024 * 1024, 'global_guard_xattr_value_unavailable');
      total += size; assert.ok(total <= 32 * 1024 * 1024, 'global_guard_xattr_total_bound');
      const value = Buffer.alloc(size || 1);
      try { assert.equal(readValue(value, size), size, 'global_guard_xattr_changed'); values.push({ name, bytes: size, sha256: createHash('sha256').update(value.subarray(0, size)).digest('hex') }); }
      finally { value.fill(0); }
    }
    const namesAfter = Buffer.alloc(capacity || 1); assert.equal(readNames(namesAfter, capacity), length, 'global_guard_xattr_names_changed');
    assert.ok(namesAfter.subarray(0, length).equals(buffer.subarray(0, length)), 'global_guard_xattr_names_changed');
    let aclSha256: string | null = null;
    if (aclGet) {
      koffi.errno(0); const acl = aclGet(ref.fd, spec.aclType);
      // Darwin filesec_get_property reports ENOENT for an absent ACL on an already-held valid fd.
      if (!acl) assert.equal(koffi.errno(), 2, 'global_guard_acl_unavailable');
      else try {
        const count = [0], text = aclText!(acl, count); assert.ok(text && Number(count[0]) >= 0 && Number(count[0]) <= 65536, 'global_guard_acl_unavailable');
        try {
          const bytes = Buffer.from(koffi.decode(text, 'uint8_t', Number(count[0]))), content = new TextDecoder('utf8', { fatal: true }).decode(bytes);
          // shortcut: extended allow ACEs are refused until their principals and rights have a native proof.
          assert.ok(content.startsWith('!#acl ') && !/:allow(?:[:,\n]|$)/.test(content), 'global_guard_extended_allow_acl_unclassified');
          aclSha256 = createHash('sha256').update(bytes).digest('hex');
        } finally { assert.equal(aclFree!(text), 0, 'global_guard_acl_close_failed'); }
      } finally { assert.equal(aclFree!(acl), 0, 'global_guard_acl_close_failed'); }
    }
    return createHash('sha256').update(JSON.stringify({ values, aclSha256 })).digest('hex');
  };
  const snapshot = (value: object): GlobalGuardIdentity => {
    const stat = fstatSync((value as Ref).fd, { bigint: true });
    assert.ok(stat.isDirectory() || stat.isFile() || stat.isSymbolicLink(), 'global_guard_special_leaf');
    if ((value as Ref).mutation) {
      assert.equal(Number(stat.uid), process.getuid?.(), 'global_guard_foreign_leaf');
      assert.ok(stat.isSymbolicLink() || (stat.mode & 0o022n) === 0n, 'global_guard_writable_leaf');
    }
    if (stat.isDirectory()) {
      assert.ok(stat.uid === 0n || Number(stat.uid) === process.getuid?.(), 'global_guard_foreign_parent');
      assert.ok((stat.mode & 0o022n) === 0n || (stat.mode & 0o1000n) !== 0n, 'global_guard_writable_parent');
    }
    let contentSha256: string | undefined;
    if (stat.isFile()) {
      assert.ok(stat.size <= 128n * 1024n * 1024n, 'global_guard_file_bound');
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
      for (;;) {
        const n = readSync((value as Ref).fd, buffer, 0, Math.min(buffer.length, 128 * 1024 * 1024 - offset + 1), offset);
        if (!n) break; offset += n; assert.ok(offset <= 128 * 1024 * 1024, 'global_guard_file_bound'); hash.update(buffer.subarray(0, n));
      }
      const after = fstatSync((value as Ref).fd, { bigint: true });
      for (const key of ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], stat[key], 'global_guard_file_changed_during_read');
      assert.equal(BigInt(offset), stat.size, 'global_guard_file_changed_during_read'); contentSha256 = hash.digest('hex');
    }
    const securitySha256 = attributes(value as Ref, stat.isSymbolicLink());
    const final = fstatSync((value as Ref).fd, { bigint: true });
    const stable = (value as Ref).parentOnly ? ['dev', 'ino', 'uid', 'gid', 'mode'] as const
      : ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const;
    for (const key of stable) assert.equal(final[key], stat[key], 'global_guard_metadata_changed_during_read');
    return { dev: String(stat.dev), ino: String(stat.ino), kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file',
      size: String(stat.size), links: String(stat.nlink), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      owner: String(stat.uid), group: String(stat.gid), mode: Number(stat.mode), securitySha256, ...(contentSha256 ? { contentSha256 } : {}) };
  };
  return {
    openRoot(path) { const fd = Number(open(path, flags | constants.O_DIRECTORY)); assert.ok(fd >= 0, 'global_guard_root_open_failed'); return { fd, parentOnly: true }; },
    openChild(parent, name, purpose) {
      let fd = Number(openat((parent as Ref).fd, name, flags));
      if (fd < 0 && koffi.errno() === spec.loopError) fd = Number(openat((parent as Ref).fd, name, spec.linkOpen | constants.O_NONBLOCK | spec.closeOnExec));
      if (fd < 0) { if (koffi.errno() === 2) return null; throw Error('global_guard_child_open_failed'); }
      return { fd, mutation: purpose === 'mutation', parentOnly: purpose === 'parent' || purpose === 'observe-parent', parent: parent as Ref, name };
    },
    snapshot,
    rename(from, name, source, to, target) {
      if (rename((from as Ref).fd, name, (to as Ref).fd, target, spec.noReplace) !== 0)
        throw Object.assign(Error('global_guard_native_rename_failed'), { nativeCode: koffi.errno() });
      Object.assign(source, { parent: to, name: target });
    },
    close(ref) { closeSync((ref as Ref).fd); },
  };
}
