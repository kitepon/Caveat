import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, fsyncSync, fchmodSync, readSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { GlobalGuardIdentity, NativeGuardDriver } from './managedGlobalGuard.js';
type Spec = { library: string | null; closeOnExec: number; linkOpen: number; loopError: number; rename: string; noReplace: number;
  directoryRead: string; directoryNameOffset: number; xattrListTail: number[]; xattrGetTail: number[]; linkAttributesViaProc: boolean; fullSync?: number; aclType?: number };
type Ref = { fd: number; mutation?: boolean; parentOnly?: boolean; parent?: Ref; name?: string };

export async function createPosixGlobalGuard(spec: Spec): Promise<NativeGuardDriver> {
  const koffi = await import('koffi'), lib = koffi.load(spec.library);
  const fullSync = spec.fullSync === undefined ? null : lib.func('int fcntl(int fd, int command)');
  const flush = (fd: number) => {
    fsyncSync(fd);
    // F_FULLFSYNC drains device caches for durable files after directory metadata fsync.
    if (fullSync && fstatSync(fd).isFile()) assert.equal(fullSync(fd, spec.fullSync), 0, 'global_guard_full_sync_failed');
  };
  const open = lib.func('int open(const char *path, int flags)');
  const openat = lib.func('int openat(int dirfd, const char *path, int flags)');
  const createat = lib.func('int openat(int dirfd, const char *path, int flags, ...)');
  const directoryOpen = lib.func('void *fdopendir(int fd)');
  // Darwin x64's versioned symbol contains '$', which the C prototype parser rejects.
  const directoryRead = lib.func(spec.directoryRead, 'void *', ['void *']);
  const directoryClose = lib.func('int closedir(void *directory)');
  const linkRead = lib.func('intptr_t readlinkat(int directory, const char *name, _Out_ void *buffer, size_t size)');
  const mkdirat = lib.func('int mkdirat(int parent, const char *name, uint32_t mode)');
  const symlinkat = lib.func('int symlinkat(const char *target, int parent, const char *name)');
  const createdWorking = new WeakSet<object>();
  const working = (ref: object) => {
    assert.ok(createdWorking.has(ref), 'global_working_owned_creation_required');
    const value = ref as Ref, stat = fstatSync(value.fd, { bigint: true });
    assert.ok(Number(stat.uid) === process.getuid?.() && (stat.isSymbolicLink() || (stat.mode & 0o077n) === 0n), 'global_working_private_required');
    assert.ok(stat.isDirectory() || stat.nlink === 1n, 'global_working_shared_file'); return value;
  };
  const createdJournals = new WeakSet<object>();
  const readOnlyJournals = new WeakSet<object>();
  const journal = (ref: object, write = false) => {
    assert.ok(createdJournals.has(ref) || !write && readOnlyJournals.has(ref), 'global_journal_owned_creation_required');
    const stat = fstatSync((ref as Ref).fd, { bigint: true });
    assert.ok(stat.isFile() && stat.nlink === 1n && Number(stat.uid) === process.getuid?.() && (stat.mode & 0o777n) === 0o600n, 'global_journal_private_file_required');
    return ref as Ref;
  };
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
  const snapshot = (value: object, metadataOnly = false): GlobalGuardIdentity => {
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
    if (stat.isFile() && !metadataOnly) {
      const limit = 128;
      assert.ok(stat.size <= BigInt(limit) * 1024n * 1024n, 'global_guard_file_bound');
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
      for (;;) {
        const n = readSync((value as Ref).fd, buffer, 0, Math.min(buffer.length, limit * 1024 * 1024 - offset + 1), offset);
        if (!n) break; offset += n; assert.ok(offset <= limit * 1024 * 1024, 'global_guard_file_bound'); hash.update(buffer.subarray(0, n));
      }
      const after = fstatSync((value as Ref).fd, { bigint: true });
      for (const key of ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], stat[key], 'global_guard_file_changed_during_read');
      assert.equal(BigInt(offset), stat.size, 'global_guard_file_changed_during_read'); contentSha256 = hash.digest('hex');
    }
    let linkTarget: string | undefined;
    if (stat.isSymbolicLink()) {
      const ref = value as Ref, bytes = Buffer.alloc(65537);
      const length = Number(spec.linkAttributesViaProc ? linkRead(ref.fd, '', bytes, bytes.length) : linkRead(ref.parent!.fd, ref.name!, bytes, bytes.length));
      assert.ok(length > 0 && length < bytes.length, 'global_guard_link_target_unavailable');
      linkTarget = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, length));
    }
    const securitySha256 = attributes(value as Ref, stat.isSymbolicLink());
    const final = fstatSync((value as Ref).fd, { bigint: true });
    const stable = (value as Ref).parentOnly ? ['dev', 'ino', 'uid', 'gid', 'mode'] as const
      : ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const;
    for (const key of stable) assert.equal(final[key], stat[key], 'global_guard_metadata_changed_during_read');
    return { dev: String(stat.dev), ino: String(stat.ino), kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file',
      size: String(stat.size), links: String(stat.nlink), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      owner: String(stat.uid), group: String(stat.gid), mode: Number(stat.mode), securitySha256, ...(contentSha256 ? { contentSha256 } : {}), ...(linkTarget !== undefined ? { linkTarget } : {}) };
  };
  const readFile = (ref: object, limit: number) => {
    const value = ref as Ref, size = fstatSync(value.fd).size;
    assert.ok(size <= limit, 'global_journal_total_bound');
    const bytes = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const n = readSync(value.fd, bytes, offset, size - offset, offset); assert.ok(n > 0, 'global_journal_readback_truncated'); offset += n; }
    return bytes;
  };
  return {
    openRoot(path) { const fd = Number(open(path, flags | constants.O_DIRECTORY)); assert.ok(fd >= 0, 'global_guard_root_open_failed'); return { fd, parentOnly: true }; },
    openChild(parent, name, purpose) {
      let fd = Number(openat((parent as Ref).fd, name, flags));
      if (fd < 0 && koffi.errno() === spec.loopError) fd = Number(openat((parent as Ref).fd, name, spec.linkOpen | constants.O_NONBLOCK | spec.closeOnExec));
      if (fd < 0) { if (koffi.errno() === 2) return null; throw Error('global_guard_child_open_failed'); }
      const ref = { fd, mutation: purpose === 'mutation', parentOnly: purpose === 'parent' || purpose === 'observe-parent', parent: parent as Ref, name };
      if (purpose === 'journal-read') readOnlyJournals.add(ref); return ref;
    },
    snapshot,
    assertPrivateDirectory(value) {
      const stat = fstatSync((value as Ref).fd, { bigint: true });
      assert.ok(stat.isDirectory() && Number(stat.uid) === process.getuid?.() && (stat.mode & 0o077n) === 0n, 'global_preservation_private_backup_required');
    },
    listDirectory(value) {
      // A fresh description avoids sharing enumeration offsets with the retained directory.
      const fd = Number(openat((value as Ref).fd, '.', flags | constants.O_DIRECTORY));
      assert.ok(fd >= 0, 'global_guard_directory_open_failed');
      const stream = directoryOpen(fd);
      if (!stream) { closeSync(fd); throw Error('global_guard_directory_stream_failed'); }
      const names: string[] = []; let count = 0;
      try {
        for (;;) {
          koffi.errno(0); const entry = directoryRead(stream);
          if (!entry) { assert.equal(koffi.errno(), 0, 'global_guard_directory_read_failed'); break; }
          assert.ok(++count <= 100002, 'global_guard_tree_entry_bound');
          const header = Buffer.from(koffi.decode(entry, 'uint8_t', spec.directoryNameOffset));
          const length = header.readUInt16LE(16);
          assert.ok(length > spec.directoryNameOffset && length <= 4096, 'global_guard_directory_record_bound');
          const bytes = Buffer.from(koffi.decode(entry, 'uint8_t', length)).subarray(spec.directoryNameOffset);
          const end = bytes.indexOf(0); assert.ok(end > 0, 'global_guard_directory_name_invalid');
          const name = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, end));
          if (name !== '.' && name !== '..') names.push(name);
          assert.ok(names.length <= 100000, 'global_guard_tree_entry_bound');
        }
        return names;
      } finally { assert.equal(directoryClose(stream), 0, 'global_guard_directory_close_failed'); }
    },
    createWorking(parent, name, kind, linkTarget) {
      let fd: number;
      if (kind === 'directory') {
        assert.equal(mkdirat((parent as Ref).fd, name, 0o700), 0, 'global_working_exclusive_directory_failed');
        fd = Number(openat((parent as Ref).fd, name, flags | constants.O_DIRECTORY));
      } else if (kind === 'link') {
        assert.ok(typeof linkTarget === 'string' && linkTarget.length > 0 && !linkTarget.includes('\0'), 'global_working_link_target_required');
        assert.equal(symlinkat(linkTarget, (parent as Ref).fd, name), 0, 'global_working_exclusive_link_failed');
        fd = Number(openat((parent as Ref).fd, name, spec.linkOpen | constants.O_NONBLOCK | spec.closeOnExec));
      } else {
        assert.equal(kind, 'file', 'global_working_kind_invalid');
        fd = Number(createat((parent as Ref).fd, name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | spec.closeOnExec, 'int', 0o600));
      }
      assert.ok(fd >= 0, 'global_working_created_open_failed');
      const ref = { fd, mutation: true, parent: parent as Ref, name }; createdWorking.add(ref); return ref;
    },
    copyWorkingFile(source, target) {
      const output = working(target), before = fstatSync((source as Ref).fd, { bigint: true }), empty = fstatSync(output.fd, { bigint: true });
      assert.ok(before.isFile() && before.nlink === 1n && before.size <= 128n * 1024n * 1024n, 'global_working_source_invalid');
      assert.ok(empty.isFile() && empty.size === 0n && !(empty.dev === before.dev && empty.ino === before.ino), 'global_working_empty_new_file_required');
      const buffer = Buffer.alloc(65536); let offset = 0;
      for (;;) {
        const count = readSync((source as Ref).fd, buffer, 0, buffer.length, offset); if (!count) break;
        assert.ok(offset + count <= Number(before.size), 'global_working_source_changed');
        assert.equal(writeSync(output.fd, buffer, 0, count, offset), count, 'global_working_partial_write'); offset += count;
      }
      assert.equal(BigInt(offset), before.size, 'global_working_source_changed');
      const after = fstatSync((source as Ref).fd, { bigint: true });
      for (const key of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key], 'global_working_source_changed');
    },
    finishWorking(ref, executable) {
      const value = working(ref), stat = fstatSync(value.fd);
      if (stat.isFile()) { fchmodSync(value.fd, executable ? 0o700 : 0o600); flush(value.fd); }
      else if (stat.isDirectory()) flush(value.fd);
      flush(value.parent!.fd);
    },
    createJournal(parent, name) {
      const stat = fstatSync((parent as Ref).fd, { bigint: true });
      assert.ok(stat.isDirectory() && Number(stat.uid) === process.getuid?.() && (stat.mode & 0o077n) === 0n, 'global_journal_private_parent_required');
      // Darwin ARM64 passes variadic arguments differently from fixed arguments.
      const fd = Number(createat((parent as Ref).fd, name, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | spec.closeOnExec, 'int', 0o600));
      assert.ok(fd >= 0, 'global_journal_exclusive_create_failed');
      const ref = { fd, mutation: true, parent: parent as Ref, name }; createdJournals.add(ref); createdWorking.add(ref); return ref;
    },
    appendJournal(ref, bytes) {
      const value = journal(ref, true); assert.ok(bytes.length <= 65536, 'global_journal_record_bound');
      assert.equal(writeSync(value.fd, bytes), bytes.length, 'global_journal_partial_write');
    },
    flushJournal(ref) { const value = journal(ref, true); flush(value.fd); flush(value.parent!.fd); },
    readJournal(ref) { return readFile(journal(ref), 16 * 1024 * 1024); },
    readFile,
    rename(from, name, source, to, target) {
      if (rename((from as Ref).fd, name, (to as Ref).fd, target, spec.noReplace) !== 0)
        throw Object.assign(Error('global_guard_native_rename_failed'), { nativeCode: koffi.errno() });
      Object.assign(source, { parent: to, name: target });
      flush((from as Ref).fd); flush((to as Ref).fd);
    },
    close(ref) { createdWorking.delete(ref); createdJournals.delete(ref); readOnlyJournals.delete(ref); closeSync((ref as Ref).fd); },
  };
}
