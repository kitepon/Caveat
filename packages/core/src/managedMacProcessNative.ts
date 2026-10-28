import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { NativeProcessRecord, ProcessExecutable, MacArgumentFailure } from './managedProcessNative.js';

const MAX_ARGUMENT_BYTES = 1024 * 1024;
const BSD_INFO_BYTES = 136;
const decode = (bytes: Buffer) => new TextDecoder('utf8', { fatal: true }).decode(bytes);

/** KERN_PROCARGS2: argc, saved executable path, padding, then exactly argc NUL strings. */
export function decodeMacArguments(bytes: Buffer) {
  assert.ok(bytes.length >= 6 && bytes.length <= MAX_ARGUMENT_BYTES, 'mac_arguments_bound');
  const count = bytes.readInt32LE(0);
  assert.ok(count > 0 && count <= 65536, 'mac_argument_count');
  let cursor = bytes.indexOf(0, 4);
  assert.ok(cursor > 4, 'mac_saved_executable_missing');
  const savedExecutable = decode(bytes.subarray(4, cursor));
  assert.ok(savedExecutable.startsWith('/'), 'mac_saved_executable_invalid');
  while (cursor < bytes.length && bytes[cursor] === 0) cursor++;
  const argv: string[] = [];
  for (let index = 0; index < count; index++) {
    const end = bytes.indexOf(0, cursor);
    assert.ok(end >= cursor && end < bytes.length, 'mac_argument_unterminated');
    // shortcut: environment-shaped arguments are rejected until argv boundaries can be proven without exec-path padding ambiguity.
    const equals = bytes.indexOf(61, cursor);
    assert.ok(equals < cursor || equals >= end || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bytes.subarray(cursor, equals).toString('ascii')), 'mac_argument_environment_shaped');
    argv.push(decode(bytes.subarray(cursor, end))); cursor = end + 1;
  }
  assert.ok(argv[0], 'mac_argv0_unavailable');
  return { savedExecutable, argv };
}

export function decodeMacBsdInfo(bytes: Buffer, pid: number) {
  assert.equal(bytes.length, BSD_INFO_BYTES, 'mac_bsd_info_size');
  assert.equal(bytes.readUInt32LE(12), pid, 'mac_bsd_pid_changed');
  const seconds = bytes.readBigUInt64LE(120), micros = bytes.readBigUInt64LE(128);
  assert.ok(micros < 1000000n, 'mac_process_birth_invalid');
  return { pid, ppid: bytes.readUInt32LE(16), uid: bytes.readUInt32LE(20),
    birth: seconds + ':' + micros, state: bytes.readUInt32LE(4) === 5 ? 'Z' : 'live',
    ...(pid === 0 && (bytes.readUInt32LE(0) & 1) ? { kernel: 'darwin-kernel-task' as const } : {}) };
}

/** Darwin LP64 kinfo_proc: extern_proc(296), two pointers(16), _pcred(104), then _ucred.cr_uid(+4). */
export function decodeMacKinfoIdentity(bytes: Buffer, pid: number) {
  assert.equal(bytes.length, 648, 'mac_kinfo_lp64_size');
  assert.equal(bytes.readInt32LE(40), pid, 'mac_kinfo_pid_changed');
  const seconds = bytes.readBigInt64LE(0), micros = bytes.readInt32LE(8);
  assert.ok(seconds >= 0n && micros >= 0 && micros < 1000000, 'mac_kinfo_birth_invalid');
  return { uid: bytes.readUInt32LE(420), birth: seconds + ':' + micros,
    kernel: pid === 0 && (bytes.readUInt32LE(32) & 0x200) !== 0 };
}

type MacSysctl = (mib: Buffer, count: number, buffer: Buffer | null, length: number[], value: null, size: number) => number;
/** Exact size/read failures are retained separately; decoding never exposes the environment segment. */
export function readMacProcessArguments(pid: number, query: MacSysctl, errno: () => number): { argv: string[] | null; failure?: MacArgumentFailure } {
  const mib = Buffer.alloc(12); [1, 49, pid].forEach((value, index) => mib.writeInt32LE(value, index * 4));
  const length = [0];
  if (query(mib, 3, null, length, null, 0) !== 0) return { argv: null, failure: { stage: 'size', nativeCode: errno(), sizeQuerySucceeded: false } };
  const size = Number(length[0]);
  if (!Number.isSafeInteger(size) || size < 6 || size > MAX_ARGUMENT_BYTES) return { argv: null, failure: { stage: 'size-bound', nativeCode: null, sizeQuerySucceeded: true } };
  const buffer = Buffer.alloc(size);
  try {
    if (query(mib, 3, buffer, length, null, 0) !== 0) return { argv: null, failure: { stage: 'read', nativeCode: errno(), sizeQuerySucceeded: true } };
    const used = Number(length[0]);
    if (!Number.isSafeInteger(used) || used < 6 || used > buffer.length) return { argv: null, failure: { stage: 'read-bound', nativeCode: null, sizeQuerySucceeded: true } };
    try { return { argv: decodeMacArguments(buffer.subarray(0, used)).argv }; }
    catch { return { argv: null, failure: { stage: 'decode', nativeCode: null, sizeQuerySucceeded: true } }; }
  } finally { buffer.fill(0); }
}

/** Native loading is lazy: ordinary hooks never load a C bridge or inspect processes. */
export async function createMacKernelReader() {
  const koffi = await import('koffi');
  const proc = koffi.load('/usr/lib/libproc.dylib'), libc = koffi.load('/usr/lib/libSystem.B.dylib');
  const list = proc.func('int proc_listpids(uint32_t type, uint32_t typeinfo, _Out_ void *buffer, int buffersize)');
  const info = proc.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int buffersize)');
  const path = proc.func('int proc_pidpath(int pid, _Out_ void *buffer, uint32_t buffersize)');
  const sysctl = libc.func('int sysctl(const int *name, uint32_t namelen, _Out_ void *oldp, _Inout_ size_t *oldlenp, const void *newp, size_t newlen)');
  const bsd = (pid: number) => {
    const buffer = Buffer.alloc(BSD_INFO_BYTES);
    if (Number(info(pid, 3, 0, buffer, buffer.length)) !== BSD_INFO_BYTES) throw Object.assign(Error('mac_process_info_unavailable'), { nativeCode: koffi.errno() });
    return decodeMacBsdInfo(buffer, pid);
  };
  const image = (pid: number): ProcessExecutable => {
    const buffer = Buffer.alloc(4096), length = Number(path(pid, buffer, buffer.length)), end = buffer.indexOf(0);
    assert.ok(length > 0 && length <= buffer.length && end > 0 && end <= length, 'mac_process_path_unavailable');
    const name = decode(buffer.subarray(0, end));
    assert.ok(name.startsWith('/') && !/[\r\n]/.test(name), 'mac_process_path_invalid');
    const stat = statSync(name, { bigint: true }); assert.ok(stat.isFile(), 'mac_process_image_nonregular');
    return { path: name, dev: String(stat.dev), ino: String(stat.ino) };
  };
  assert.equal(koffi.sizeof('void *'), 8, 'mac_kinfo_lp64_required');
  const kinfo = (pid: number) => {
    const mib = Buffer.alloc(16); [1, 14, 1, pid].forEach((value, index) => mib.writeInt32LE(value, index * 4));
    const buffer = Buffer.alloc(648), length = [buffer.length];
    if (Number(sysctl(mib, 4, buffer, length, null, 0)) !== 0) throw Object.assign(Error('mac_kinfo_unavailable'), { nativeCode: koffi.errno() });
    assert.equal(Number(length[0]), buffer.length, 'mac_kinfo_lp64_size');
    return decodeMacKinfoIdentity(buffer, pid);
  };
  const args = (pid: number) => readMacProcessArguments(pid, (...values) => Number(sysctl(...values)), () => koffi.errno());
  const readProcess = (pid: number): NativeProcessRecord => {
    let phase = 'kinfo';
    const code = (error: unknown) => { const value = error as { nativeCode?: number; errno?: number }; return value.nativeCode ?? value.errno ?? null; };
    let row: NativeProcessRecord = { pid, ppid: null, uid: null, birth: null, executable: null, argv: null };
    try {
      const owner = kinfo(pid);
      if (owner.kernel) return { ...row, ppid: 0, uid: owner.uid, birth: owner.birth, kernel: 'darwin-kernel-task', ownerProof: 'darwin-kinfo-proc' };
      phase = 'bsd'; const first = bsd(pid); row = { ...row, ...first };
      assert.equal(owner.uid, first.uid, 'mac_kinfo_uid_changed'); assert.equal(owner.birth, first.birth, 'mac_kinfo_birth_changed');
      row.ownerProof = 'darwin-kinfo-proc';
      if (!first.kernel && first.state !== 'Z') {
        phase = 'arguments'; const argument = args(pid); row.argv = argument.argv; if (argument.failure) row.argumentFailure = argument.failure;
        phase = 'image';
        try { row.executable = image(pid); } catch (error) { row.kernelFailure = { stage: phase, nativeCode: code(error) }; }
        phase = 'image-recheck';
        if (row.executable) assert.deepEqual(image(pid), row.executable, 'mac_process_image_changed');
        phase = 'arguments-recheck';
        if (row.argv) {
          const current = args(pid);
          if (!current.argv && current.failure?.stage === 'read' && current.failure.nativeCode === 22) { row.argumentFailure = current.failure; }
          else assert.ok(isDeepStrictEqual(current.argv, row.argv), 'mac_process_arguments_changed');
        }
      }
      phase = 'bsd-recheck'; assert.deepEqual(bsd(pid), first, 'mac_process_birth_changed');
      phase = 'kinfo-recheck'; assert.deepEqual(kinfo(pid), owner, 'mac_kinfo_identity_changed');
      return row;
    } catch (error) { return { ...row, reason: 'mac_kernel_metadata_unverified', kernelFailure: { stage: phase, nativeCode: code(error) } }; }
  };
  return {
    readProcess,
    readTable(deadline: number) {
      const needed = Number(list(1, 0, null, 0));
      assert.ok(Number.isSafeInteger(needed) && needed > 0 && needed <= 400000, 'mac_process_table_bound');
      const buffer = Buffer.alloc(Math.min(400000, needed + 4096)), used = Number(list(1, 0, buffer, buffer.length));
      assert.ok(used > 0 && used < buffer.length && used % 4 === 0, 'mac_process_table_truncated');
      const pids: number[] = [];
      for (let offset = 0; offset < used; offset += 4) {
        const pid = buffer.readInt32LE(offset); assert.ok(pid >= 0, 'mac_process_pid_invalid'); pids.push(pid);
      }
      assert.equal(new Set(pids).size, pids.length, 'mac_process_pid_duplicate');
      let total = 0;
      return pids.sort((a, b) => a - b).map(pid => {
        assert.ok(Date.now() <= deadline, 'process_probe_deadline');
        const row = readProcess(pid); total += Buffer.byteLength(JSON.stringify(row));
        assert.ok(total <= 16 * 1024 * 1024, 'process_table_byte_bound');
        return row;
      });
    },
  };
}
