import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { GlobalGuardIdentity, NativeGuardDriver } from './managedGlobalGuard.js';

const systemTrustees = ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'];
export function isGuardTrustedOwner(owner: string, current: string, mutation: boolean) {
  return owner === current || !mutation && systemTrustees.includes(owner);
}

/** SID and ACL buffers are bounded before any native pointer is decoded beyond their headers. */
export function decodeGuardSid(bytes: Buffer) {
  assert.ok(bytes.length >= 8 && bytes[0] === 1 && bytes[1]! <= 15 && bytes.length === 8 + 4 * bytes[1]!, 'global_guard_invalid_sid');
  const authority = bytes.readUIntBE(2, 6), parts: number[] = [];
  for (let index = 8; index < bytes.length; index += 4) parts.push(bytes.readUInt32LE(index));
  return 'S-1-' + authority + (parts.length ? '-' + parts.join('-') : '');
}
export function verifyGuardAcl(bytes: Buffer, trusted: Set<string>, mutation: boolean, privateOwner?: string) {
  assert.ok(bytes.length >= 8 && bytes.length <= 65535 && bytes.readUInt16LE(2) === bytes.length, 'global_guard_invalid_acl');
  assert.ok(bytes[0] === 2 || bytes[0] === 4, 'global_guard_unsupported_acl_revision');
  let offset = 8;
  for (let index = 0; index < bytes.readUInt16LE(4); index++) {
    assert.ok(offset + 8 <= bytes.length, 'global_guard_truncated_ace');
    const type = bytes[offset]!, flags = bytes[offset + 1]!, size = bytes.readUInt16LE(offset + 2);
    assert.ok(size >= 16 && offset + size <= bytes.length && (type === 0 || type === 1), 'global_guard_unsupported_ace');
    const mask = bytes.readUInt32LE(offset + 4), sid = decodeGuardSid(bytes.subarray(offset + 8, offset + size));
    // Ancestors may permit creation, but never replacement or security/attribute changes by an ordinary foreign principal.
    const writes = 0x10000000 | 0x40000000 | 0x000d0150 | (mutation ? 0x6 : 0);
    if (privateOwner && type === 0) assert.ok(sid === privateOwner, 'global_journal_foreign_acl_reader');
    if (type === 0 && !(flags & 8) && (mask & writes) !== 0) assert.ok(trusted.has(sid), 'global_guard_foreign_acl_writer');
    offset += size;
  }
  assert.ok(offset <= bytes.length, 'global_guard_invalid_acl');
}

type Ref = { handle: unknown; mutation: boolean };
export async function createWindowsGlobalGuard(): Promise<NativeGuardDriver> {
  const koffi = await import('koffi');
  assert.equal(koffi.sizeof('void *'), 8, 'global_guard_64_bit_windows_required');
  const kernel = koffi.load('kernel32.dll'), native = koffi.load('ntdll.dll'), security = koffi.load('advapi32.dll');
  const create = kernel.func('void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const info = kernel.func('int __stdcall GetFileInformationByHandleEx(void *handle, int kind, _Out_ void *buffer, uint32_t size)');
  const rename = native.func('int32_t __stdcall NtSetInformationFile(void *handle, _Out_ void *status, const void *buffer, uint32_t size, int kind)');
  const seek = kernel.func('int __stdcall SetFilePointerEx(void *handle, int64_t position, void *result, uint32_t method)');
  const read = kernel.func('int __stdcall ReadFile(void *handle, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *count, void *overlapped)');
  const write = kernel.func('int __stdcall WriteFile(void *handle, const void *buffer, uint32_t size, _Out_ uint32_t *count, void *overlapped)');
  const flush = kernel.func('int __stdcall FlushFileBuffers(void *handle)');
  const openRelative = native.func('int32_t __stdcall NtCreateFile(_Out_ void **handle, uint32_t access, const void *attributes, _Out_ void *status, const void *allocation, uint32_t fileAttributes, uint32_t share, uint32_t disposition, uint32_t options, const void *ea, uint32_t eaLength)');
  const queryDirectory = native.func('int32_t __stdcall NtQueryDirectoryFile(void *handle, void *event, void *routine, void *context, _Out_ void *status, _Out_ void *buffer, uint32_t length, int kind, uint8_t single, void *pattern, uint8_t restart)');
  const getSecurity = security.func('uint32_t __stdcall GetSecurityInfo(void *handle, int type, uint32_t requested, _Out_ void **owner, _Out_ void **group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)');
  const descriptorControl = security.func('int __stdcall GetSecurityDescriptorControl(const void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)');
  const toString = security.func('int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(const void *descriptor, uint32_t revision, uint32_t requested, _Out_ void **text, _Out_ uint32_t *length)');
  const localFree = kernel.func('void * __stdcall LocalFree(void *memory)');
  const currentProcess = kernel.func('void * __stdcall GetCurrentProcess()');
  const openToken = security.func('int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)');
  const tokenInfo = security.func('int __stdcall GetTokenInformation(void *token, int kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *needed)');
  const bytesAt = (pointer: unknown, size: number) => Buffer.from(koffi.decode(pointer, 'uint8_t', size));
  const sidAt = (pointer: unknown) => {
    assert.ok(pointer, 'global_guard_sid_missing'); const header = bytesAt(pointer, 8);
    assert.ok(header[1]! <= 15, 'global_guard_sid_bound'); return decodeGuardSid(bytesAt(pointer, 8 + 4 * header[1]!));
  };
  const own: unknown[] = [null]; assert.notEqual(openToken(currentProcess(), 8, own), 0, 'global_guard_token_unavailable');
  let currentSid: string, currentSidBytes: Buffer;
  try {
    const buffer = Buffer.alloc(256), needed = [0];
    assert.notEqual(tokenInfo(own[0], 1, buffer, buffer.length, needed), 0, 'global_guard_token_unavailable');
    const pointer = koffi.decode(buffer, 'void *'); currentSid = sidAt(pointer);
    currentSidBytes = bytesAt(pointer, 8 + 4 * bytesAt(pointer, 8)[1]!);
  } finally { assert.notEqual(close(own[0]), 0, 'global_guard_token_close_failed'); }
  const trusted = new Set([currentSid, ...systemTrustees]);
  const createdWorking = new WeakSet<object>();
  const createdJournals = new WeakSet<object>();
  const readOnlyJournals = new WeakSet<object>();
  const journal = (ref: object, write = false) => {
    assert.ok(createdJournals.has(ref) || !write && readOnlyJournals.has(ref), 'global_journal_owned_creation_required');
    assert.equal(descriptor({ ...(ref as Ref), mutation: true }, true).owner, currentSid, 'global_journal_private_file_required'); return ref as Ref;
  };
  const journalSecurity = () => {
    const sid = currentSidBytes, aclSize = 16 + sid.length, bytes = Buffer.alloc(20 + sid.length + aclSize), acl = 20 + sid.length;
    bytes[0] = 1; bytes.writeUInt16LE(0x9004, 2); bytes.writeUInt32LE(20, 4); bytes.writeUInt32LE(acl, 16); sid.copy(bytes, 20);
    bytes[acl] = 2; bytes.writeUInt16LE(aclSize, acl + 2); bytes.writeUInt16LE(1, acl + 4);
    bytes.writeUInt16LE(8 + sid.length, acl + 10); bytes.writeUInt32LE(0x001f01ff, acl + 12); sid.copy(bytes, acl + 16);
    return bytes;
  };
  const descriptor = (ref: Ref, privateFile = createdWorking.has(ref) || createdJournals.has(ref) || readOnlyJournals.has(ref)) => {
    const owner: unknown[] = [null], group: unknown[] = [null], dacl: unknown[] = [null], sd: unknown[] = [null];
    assert.equal(getSecurity(ref.handle, 1, 7, owner, group, dacl, null, sd), 0, 'global_guard_security_unavailable');
    try {
      const ownerSid = sidAt(owner[0]), groupSid = sidAt(group[0]);
      assert.ok(isGuardTrustedOwner(ownerSid, currentSid, ref.mutation), 'global_guard_foreign_owner');
      assert.ok(dacl[0], 'global_guard_null_dacl');
      if (privateFile) {
        const control = [0], revision = [0];
        assert.notEqual(descriptorControl(sd[0], control, revision), 0, 'global_journal_security_unavailable');
        assert.ok((Number(control[0]) & 0x1000) !== 0, 'global_journal_dacl_unprotected');
      }
      const header = bytesAt(dacl[0], 8), size = header.readUInt16LE(2);
      assert.ok(size >= 8 && size <= 65535, 'global_guard_acl_bound'); verifyGuardAcl(bytesAt(dacl[0], size), trusted, ref.mutation, privateFile ? currentSid : undefined);
      const text: unknown[] = [null], length = [0];
      assert.notEqual(toString(sd[0], 1, 7, text, length), 0, 'global_guard_security_unavailable');
      try {
        assert.ok(length[0]! > 0 && length[0]! <= 65536, 'global_guard_security_bound');
        const sddl = bytesAt(text[0], Number(length[0]) * 2);
        return { owner: ownerSid, group: groupSid, securitySha256: createHash('sha256').update(sddl).digest('hex') };
      } finally { localFree(text[0]); }
    } finally { localFree(sd[0]); }
  };
  const snapshot = (value: object): GlobalGuardIdentity => {
    const ref = value as Ref, id = Buffer.alloc(24), basic = Buffer.alloc(40), standard = Buffer.alloc(24);
    assert.notEqual(info(ref.handle, 18, id, id.length), 0, 'global_guard_file_id_unavailable');
    assert.notEqual(info(ref.handle, 0, basic, basic.length), 0, 'global_guard_file_info_unavailable');
    assert.notEqual(info(ref.handle, 1, standard, standard.length), 0, 'global_guard_file_info_unavailable');
    assert.ok(id.subarray(8).some(value => value !== 0), 'global_guard_file_id_unavailable');
    assert.ok((basic.readUInt32LE(32) & 0x400) === 0 && !standard[20], 'global_guard_reparse_or_delete_pending');
    let contentSha256: string | undefined;
    if (!standard[21]) {
      const size = standard.readBigInt64LE(8); assert.ok(size >= 0n && size <= 128n * 1024n * 1024n, 'global_guard_file_bound');
      assert.notEqual(seek(ref.handle, 0, null, 0), 0, 'global_guard_file_seek_failed');
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let total = 0;
      for (;;) {
        const count = [0]; assert.notEqual(read(ref.handle, buffer, buffer.length, count, null), 0, 'global_guard_file_read_failed');
        const n = Number(count[0]); assert.ok(n >= 0 && n <= buffer.length, 'global_guard_file_read_failed');
        if (!n) break; total += n; assert.ok(total <= 128 * 1024 * 1024, 'global_guard_file_bound'); hash.update(buffer.subarray(0, n));
      }
      const after = Buffer.alloc(40); assert.notEqual(info(ref.handle, 0, after, after.length), 0, 'global_guard_file_info_unavailable');
      assert.equal(BigInt(total), size, 'global_guard_file_changed_during_read');
      // Last-access time may change because of this read; compare write/change times and attributes.
      assert.ok(after.subarray(16, 36).equals(basic.subarray(16, 36)), 'global_guard_file_changed_during_read'); contentSha256 = hash.digest('hex');
    }
    return { dev: String(id.readBigUInt64LE()), ino: id.subarray(8).toString('hex'),
      kind: standard[21] ? 'directory' : 'file', size: String(standard.readBigInt64LE(8)), links: String(standard.readUInt32LE(16)),
      mtime: String(basic.readBigInt64LE(16)), ctime: String(basic.readBigInt64LE(24)), mode: basic.readUInt32LE(32), ...descriptor(ref), ...(contentSha256 ? { contentSha256 } : {}) };
  };
  const openChild = (parent: object, name: string, purpose: Parameters<NativeGuardDriver['openChild']>[2], creating: false | 'file' | 'directory' = false): Ref | null => {
    const mutation = purpose === 'mutation';
    const nameBuffer = Buffer.from(name + '\0', 'utf16le'), unicode = Buffer.alloc(16), attributes = Buffer.alloc(48), status = Buffer.alloc(16), handle: unknown[] = [null];
    const sd = creating ? journalSecurity() : null;
    unicode.writeUInt16LE(nameBuffer.length - 2); unicode.writeUInt16LE(nameBuffer.length, 2); unicode.writeBigUInt64LE(koffi.address(nameBuffer), 8);
    attributes.writeUInt32LE(48); attributes.writeBigUInt64LE(koffi.address((parent as Ref).handle), 8); attributes.writeBigUInt64LE(koffi.address(unicode), 16); attributes.writeUInt32LE(0x1040, 24);
    if (sd) attributes.writeBigUInt64LE(koffi.address(sd), 32);
    // Observations must share our already-held DELETE access; the original pin still denies foreign writes/deletes.
    const share = mutation ? 1 : purpose === 'parent' ? 3 : 7;
    const access = 0x00120081 | (mutation ? 0x10000 : 0) | (creating ? 0x40000000 : 0);
    const result = Number(openRelative(handle, access, attributes, status, null, creating === 'directory' ? 0x10 : creating ? 0x80 : 0, share, creating ? 2 : 1, creating === 'directory' ? 0x23 : 0x00200020 | (creating ? 0x42 : 0), null, 0));
    // Keep nested buffers alive across the native call; raw addresses do not root them for GC.
    assert.equal(unicode.readUInt16LE(0), nameBuffer.length - 2); assert.equal(nameBuffer.readUInt16LE(nameBuffer.length - 2), 0);
    if (sd) assert.equal(sd.readUInt16LE(2), 0x9004);
    if (result !== 0) {
      if (!creating && (result === -1073741772 || result === -1073741766)) return null;
      throw Object.assign(Error('global_guard_relative_open_failed_' + (result >>> 0).toString(16)), { nativeCode: result >>> 0 });
    }
    const ref = { handle: handle[0], mutation }; if (purpose === 'journal-read') readOnlyJournals.add(ref); return ref;
  };
  return {
    openRoot(path) {
      assert.match(path, /^[a-z]:[\\/]$/i, 'global_guard_local_volume_required');
      const handle = create(path, 0x00120081, 3, null, 3, 0x02200000, null);
      assert.ok(handle && koffi.address(handle) !== 0xffffffffffffffffn, 'global_guard_root_open_failed');
      return { handle, mutation: false };
    },
    openChild,
    snapshot,
    assertPrivateDirectory(value) {
      assert.equal(snapshot(value).kind, 'directory', 'global_preservation_private_backup_required');
      assert.equal(descriptor({ ...(value as Ref), mutation: true }, true).owner, currentSid, 'global_preservation_private_backup_required');
    },
    listDirectory(value) {
      const buffer = Buffer.alloc(65536), status = Buffer.alloc(16), names: string[] = [];
      for (let index = 0; ; index++) {
        const result = Number(queryDirectory((value as Ref).handle, null, null, null, status, buffer, buffer.length, 12, 1, null, index === 0 ? 1 : 0));
        if ((result >>> 0) === 0x80000006) break;
        assert.equal(result, 0, 'global_guard_directory_read_failed');
        const size = Number(status.readBigUInt64LE(8));
        assert.ok(size >= 12 && size <= buffer.length && buffer.readUInt32LE(0) === 0, 'global_guard_directory_record_bound');
        const length = buffer.readUInt32LE(8);
        assert.ok(length > 0 && length % 2 === 0 && length + 12 <= size, 'global_guard_directory_name_invalid');
        const name = new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(12, 12 + length));
        if (name !== '.' && name !== '..') names.push(name);
        assert.ok(index <= 100002 && names.length <= 100000, 'global_guard_tree_entry_bound');
      }
      return names;
    },
    createWorking(parent, name, kind) {
      assert.ok(kind === 'file' || kind === 'directory', 'global_working_windows_link_unsupported');
      const ref = openChild(parent, name, 'mutation', kind)!; createdWorking.add(ref); return ref;
    },
    copyWorkingFile(source, target) {
      assert.ok(createdWorking.has(target), 'global_working_owned_creation_required');
      const before = snapshot(source), empty = snapshot(target);
      assert.ok(before.kind === 'file' && before.links === '1' && empty.kind === 'file' && empty.links === '1' && empty.size === '0'
        && !(before.dev === empty.dev && before.ino === empty.ino), 'global_working_empty_new_file_required');
      assert.equal(descriptor(target as Ref, true).owner, currentSid, 'global_working_private_required');
      assert.notEqual(seek((source as Ref).handle, 0, null, 0), 0, 'global_working_seek_failed');
      assert.notEqual(seek((target as Ref).handle, 0, null, 0), 0, 'global_working_seek_failed');
      const buffer = Buffer.alloc(65536); let total = 0;
      for (;;) {
        const count = [0]; assert.notEqual(read((source as Ref).handle, buffer, buffer.length, count, null), 0, 'global_working_read_failed');
        const size = Number(count[0]); assert.ok(size >= 0 && size <= buffer.length, 'global_working_read_failed'); if (!size) break;
        total += size; assert.ok(total <= Number(before.size), 'global_working_source_changed');
        const written = [0]; assert.notEqual(write((target as Ref).handle, buffer, size, written, null), 0, 'global_working_write_failed');
        assert.equal(Number(written[0]), size, 'global_working_partial_write');
      }
      assert.equal(total, Number(before.size), 'global_working_source_changed'); assert.deepEqual(snapshot(source), before, 'global_working_source_changed');
    },
    finishWorking(ref) {
      assert.ok(createdWorking.has(ref), 'global_working_owned_creation_required');
      assert.equal(descriptor(ref as Ref, true).owner, currentSid, 'global_working_private_required');
      // New directories use FILE_WRITE_THROUGH; only the owned data file handle is flushed here.
      if (snapshot(ref).kind === 'file') assert.notEqual(flush((ref as Ref).handle), 0, 'global_working_flush_failed');
    },
    createJournal(parent, name) {
      assert.equal(descriptor({ ...(parent as Ref), mutation: true }).owner, currentSid, 'global_journal_private_parent_required');
      const ref = openChild(parent, name, 'mutation', 'file')!; createdJournals.add(ref); return ref;
    },
    appendJournal(ref, bytes) {
      const value = journal(ref, true), count = [0]; assert.ok(bytes.length <= 65536, 'global_journal_record_bound');
      assert.notEqual(seek(value.handle, 0, null, 2), 0, 'global_journal_seek_failed');
      assert.notEqual(write(value.handle, bytes, bytes.length, count, null), 0, 'global_journal_write_failed');
      assert.equal(Number(count[0]), bytes.length, 'global_journal_partial_write');
    },
    flushJournal(ref) { assert.notEqual(flush(journal(ref, true).handle), 0, 'global_journal_flush_failed'); },
    readJournal(ref) {
      const value = journal(ref), buffer = Buffer.alloc(65536), chunks: Buffer[] = []; let size = 0;
      assert.notEqual(seek(value.handle, 0, null, 0), 0, 'global_journal_seek_failed');
      for (;;) {
        const count = [0]; assert.notEqual(read(value.handle, buffer, buffer.length, count, null), 0, 'global_journal_read_failed');
        const n = Number(count[0]); assert.ok(n >= 0 && n <= buffer.length, 'global_journal_read_failed'); if (!n) break;
        size += n; assert.ok(size <= 16 * 1024 * 1024, 'global_journal_total_bound'); chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
      return Buffer.concat(chunks);
    },
    rename(_from, _name, source, to, target) {
      const name = Buffer.from(target, 'utf16le'), buffer = Buffer.alloc(24 + name.length);
      buffer.writeBigUInt64LE(koffi.address((to as Ref).handle), 8); buffer.writeUInt32LE(name.length, 16); name.copy(buffer, 20);
      // ReplaceIfExists remains FALSE. Source and target parent are retained handles.
      const status = Buffer.alloc(16), result = Number(rename((source as Ref).handle, status, buffer, buffer.length, 10));
      if (result !== 0) throw Object.assign(Error('global_guard_native_rename_failed'), { nativeCode: result >>> 0 });
    },
    close(value) { createdWorking.delete(value); createdJournals.delete(value); readOnlyJournals.delete(value); assert.notEqual(close((value as Ref).handle), 0, 'global_guard_handle_close_unconfirmed'); },
  };
}
