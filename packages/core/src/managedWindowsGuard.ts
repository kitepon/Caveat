import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { GlobalGuardIdentity, NativeGuardDriver } from './managedGlobalGuard.js';

/** SID and ACL buffers are bounded before any native pointer is decoded beyond their headers. */
export function decodeGuardSid(bytes: Buffer) {
  assert.ok(bytes.length >= 8 && bytes[0] === 1 && bytes[1]! <= 15 && bytes.length === 8 + 4 * bytes[1]!, 'global_guard_invalid_sid');
  const authority = bytes.readUIntBE(2, 6), parts: number[] = [];
  for (let index = 8; index < bytes.length; index += 4) parts.push(bytes.readUInt32LE(index));
  return 'S-1-' + authority + (parts.length ? '-' + parts.join('-') : '');
}
export function verifyGuardAcl(bytes: Buffer, trusted: Set<string>, mutation: boolean) {
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
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const info = kernel.func('int __stdcall GetFileInformationByHandleEx(void *handle, int kind, _Out_ void *buffer, uint32_t size)');
  const rename = kernel.func('int __stdcall SetFileInformationByHandle(void *handle, int kind, const void *buffer, uint32_t size)');
  const seek = kernel.func('int __stdcall SetFilePointerEx(void *handle, int64_t position, void *result, uint32_t method)');
  const read = kernel.func('int __stdcall ReadFile(void *handle, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *count, void *overlapped)');
  const openRelative = native.func('int32_t __stdcall NtCreateFile(_Out_ void **handle, uint32_t access, const void *attributes, _Out_ void *status, const void *allocation, uint32_t fileAttributes, uint32_t share, uint32_t disposition, uint32_t options, const void *ea, uint32_t eaLength)');
  const getSecurity = security.func('uint32_t __stdcall GetSecurityInfo(void *handle, int type, uint32_t requested, _Out_ void **owner, _Out_ void **group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)');
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
  let currentSid: string;
  try {
    const buffer = Buffer.alloc(256), needed = [0];
    assert.notEqual(tokenInfo(own[0], 1, buffer, buffer.length, needed), 0, 'global_guard_token_unavailable');
    currentSid = sidAt(koffi.decode(buffer, 'void *'));
  } finally { assert.notEqual(close(own[0]), 0, 'global_guard_token_close_failed'); }
  const trusted = new Set([currentSid, 'S-1-5-18', 'S-1-5-32-544']);
  const descriptor = (ref: Ref) => {
    const owner: unknown[] = [null], group: unknown[] = [null], dacl: unknown[] = [null], sd: unknown[] = [null];
    assert.equal(getSecurity(ref.handle, 1, 7, owner, group, dacl, null, sd), 0, 'global_guard_security_unavailable');
    try {
      const ownerSid = sidAt(owner[0]), groupSid = sidAt(group[0]);
      assert.ok(ref.mutation ? ownerSid === currentSid : trusted.has(ownerSid), 'global_guard_foreign_owner');
      assert.ok(dacl[0], 'global_guard_null_dacl');
      const header = bytesAt(dacl[0], 8), size = header.readUInt16LE(2);
      assert.ok(size >= 8 && size <= 65535, 'global_guard_acl_bound'); verifyGuardAcl(bytesAt(dacl[0], size), trusted, ref.mutation);
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
  return {
    openRoot(path) {
      assert.match(path, /^[a-z]:[\\/]$/i, 'global_guard_local_volume_required');
      const handle = create(path, 0x00120081, 3, null, 3, 0x02200000, null);
      assert.ok(handle && koffi.address(handle) !== 0xffffffffffffffffn, 'global_guard_root_open_failed');
      return { handle, mutation: false };
    },
    openChild(parent, name, mutation) {
      const nameBuffer = Buffer.from(name + '\0', 'utf16le'), unicode = Buffer.alloc(16), attributes = Buffer.alloc(48), status = Buffer.alloc(16), handle: unknown[] = [null];
      unicode.writeUInt16LE(nameBuffer.length - 2); unicode.writeUInt16LE(nameBuffer.length, 2); unicode.writeBigUInt64LE(koffi.address(nameBuffer), 8);
      attributes.writeUInt32LE(48); attributes.writeBigUInt64LE(koffi.address((parent as Ref).handle), 8); attributes.writeBigUInt64LE(koffi.address(unicode), 16); attributes.writeUInt32LE(0x1040, 24);
      const result = Number(openRelative(handle, 0x00120081 | (mutation ? 0x10000 : 0), attributes, status, null, 0, mutation ? 1 : 3, 1, 0x00200020, null, 0));
      if (result !== 0) {
        if (result === -1073741772 || result === -1073741766) return null; // STATUS_OBJECT_NAME_NOT_FOUND / PATH_NOT_FOUND
        throw Error('global_guard_relative_open_failed');
      }
      return { handle: handle[0], mutation };
    },
    snapshot,
    rename(_from, _name, source, to, target) {
      const name = Buffer.from(target, 'utf16le'), buffer = Buffer.alloc(24 + name.length);
      buffer.writeBigUInt64LE(koffi.address((to as Ref).handle), 8); buffer.writeUInt32LE(name.length, 16); name.copy(buffer, 20);
      // ReplaceIfExists remains FALSE. Source and target parent are retained handles.
      if (!rename((source as Ref).handle, 3, buffer, buffer.length)) throw Error('global_guard_native_rename_failed_' + lastError());
    },
    close(value) { assert.notEqual(close((value as Ref).handle), 0, 'global_guard_handle_close_unconfirmed'); },
  };
}
