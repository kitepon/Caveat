import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { NativeProcessRecord, ProcessExecutable, MacArgumentFailure, MacTextObservation } from './managedProcessNative.js';

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
  while (cursor < bytes.length && bytes[cursor] === 0) cursor++;
  const argv: string[] = [];
  for (let index = 0; index < count; index++) {
    const end = bytes.indexOf(0, cursor);
    assert.ok(end >= cursor && end < bytes.length, 'mac_argument_unterminated');
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
  const ppid = bytes.readInt32LE(560); assert.ok(ppid >= 0, 'mac_kinfo_parent_invalid');
  return { pid, ppid, uid: bytes.readUInt32LE(420), birth: seconds + ':' + micros, state: bytes.readInt8(36) === 5 ? 'Z' : 'live',
    kernel: pid === 0 && (bytes.readUInt32LE(32) & 0x200) !== 0 };
}

type MacSysctl = (mib: Buffer, count: number, buffer: Buffer | null, length: number[], value: null, size: number) => number;
export function readMacKinfoIdentity(pid: number, query: MacSysctl, errno: () => number) {
  const mib = Buffer.alloc(16); [1, 14, 1, pid].forEach((value, index) => mib.writeInt32LE(value, index * 4));
  const buffer = Buffer.alloc(648), length = [buffer.length];
  if (query(mib, 4, buffer, length, null, 0) !== 0) throw Object.assign(Error('mac_kinfo_unavailable'), { nativeCode: errno() });
  if (Number(length[0]) === 0) throw Object.assign(Error('mac_kinfo_process_absent'), { initialKinfoAbsent: true, nativeCode: 0 });
  assert.equal(Number(length[0]), buffer.length, 'mac_kinfo_lp64_size');
  return decodeMacKinfoIdentity(buffer, pid);
}
export function confirmMacInitialExit(row: NativeProcessRecord, phase: string, error: unknown, group: (pid: number) => { result: number; nativeCode: number }) {
  if (phase !== 'kinfo' || row.pid <= 0 || row.pid > 0x7fffffff || row.argv !== null || row.executable !== null || row.uid !== null || row.birth !== null
    || (error as { initialKinfoAbsent?: boolean })?.initialKinfoAbsent !== true) return false;
  const proof = group(row.pid); return proof.result === -1 && proof.nativeCode === 3;
}
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
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      const decodeReason = ['mac_argument_count', 'mac_saved_executable_missing', 'mac_argument_unterminated', 'mac_argv0_unavailable'].find(reason => message.includes(reason)) ?? 'utf8-or-invalid';
      return { argv: null, failure: { stage: 'decode', nativeCode: null, sizeQuerySucceeded: true, decodeReason } };
    }
  } finally { buffer.fill(0); }
}

/** LP64 proc_regionwithpathinfo: region(96), vnode_info(152), path(1024). */
export function readMacTextRegions(pid: number, query: (pid: number, flavor: number, address: bigint, bytes: Buffer, size: number) => number, errno: () => number): MacTextObservation {
  let address = 0n;
  const identities: MacTextObservation['identities'] = [];
  for (let index = 0; index < 256; index++) {
    const bytes = Buffer.alloc(1272), size = query(pid, 8, address, bytes, bytes.length);
    if (size !== bytes.length) return { status: identities.length && size === 0 && errno() === 22 ? 'read' : 'unreadable', identities, stage: 'region-read', nativeCode: errno() };
    const start = bytes.readBigUInt64LE(80), length = bytes.readBigUInt64LE(88), next = start + length;
    if (!length || start < address || next <= address || next > 0xffffffffffffffffn) return { status: 'unreadable', identities, stage: 'region-bound', nativeCode: null };
    const ino = bytes.readBigUInt64LE(104), dev = bytes.readUInt32LE(96);
    if ((bytes.readUInt32LE(0) & 4) !== 0 && ino > 0n) identities.push({ dev: String(dev), ino: String(ino) });
    address = next;
  }
  return { status: 'unreadable', identities, stage: 'region-count-bound', nativeCode: null };
}

/** Native loading is lazy: ordinary hooks never load a C bridge or inspect processes. */
export async function createMacKernelReader() {
  const koffi = await import('koffi');
  const proc = koffi.load('/usr/lib/libproc.dylib'), libc = koffi.load('/usr/lib/libSystem.B.dylib');
  const list = proc.func('int proc_listpids(uint32_t type, uint32_t typeinfo, _Out_ void *buffer, int buffersize)');
  const info = proc.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int buffersize)');
  const path = proc.func('int proc_pidpath(int pid, _Out_ void *buffer, uint32_t buffersize)');
  const sysctl = libc.func('int sysctl(const int *name, uint32_t namelen, _Out_ void *oldp, _Inout_ size_t *oldlenp, const void *newp, size_t newlen)');
  const getGroup = libc.func('int getpgid(int pid)');
  const bsd = (pid: number) => {
    const buffer = Buffer.alloc(BSD_INFO_BYTES);
    if (Number(info(pid, 3, 0, buffer, buffer.length)) !== BSD_INFO_BYTES) throw Object.assign(Error('mac_process_info_unavailable'), { nativeCode: koffi.errno() });
    return decodeMacBsdInfo(buffer, pid);
  };
  const image = (pid: number): ProcessExecutable => {
    const buffer = Buffer.alloc(4096), length = Number(path(pid, buffer, buffer.length)), end = buffer.indexOf(0);
    if (!(length > 0 && length <= buffer.length && end > 0 && end <= length)) throw Object.assign(Error('mac_process_path_unavailable'), { nativeCode: koffi.errno(), nativeStage: length > 0 ? 'invalid-result' : 'proc-pidpath' });
    const name = decode(buffer.subarray(0, end));
    assert.ok(name.startsWith('/') && !/[\r\n]/.test(name), 'mac_process_path_invalid');
    let stat;
    try { stat = statSync(name, { bigint: true }); }
    catch (error) { throw Object.assign(error as Error, { nativeStage: 'stat' }); }
    assert.ok(stat.isFile(), 'mac_process_image_nonregular');
    return { path: name, dev: String(stat.dev), ino: String(stat.ino) };
  };
  assert.equal(koffi.sizeof('void *'), 8, 'mac_kinfo_lp64_required');
  const kinfo = (pid: number) => readMacKinfoIdentity(pid, (...values) => Number(sysctl(...values)), () => koffi.errno());
  const args = (pid: number) => readMacProcessArguments(pid, (...values) => Number(sysctl(...values)), () => koffi.errno());
  const calibration = kinfo(process.pid), currentBsd = bsd(process.pid);
  assert.deepEqual([calibration.pid, calibration.ppid, calibration.uid, calibration.birth],
    [currentBsd.pid, currentBsd.ppid, currentBsd.uid, currentBsd.birth], 'mac_kinfo_self_calibration_failed');
  const readProcess = (pid: number): NativeProcessRecord => {
    let phase = 'kinfo';
    const code = (error: unknown) => { const value = error as { nativeCode?: number; errno?: number }; return value.nativeCode ?? value.errno ?? null; };
    let row: NativeProcessRecord = { pid, ppid: null, uid: null, birth: null, executable: null, argv: null };
    try {
      const owner = kinfo(pid);
      row = { ...row, ppid: owner.ppid, uid: owner.uid, birth: owner.birth, state: owner.state, ownerProof: 'darwin-kinfo-proc' };
      if (owner.kernel) row.kernel = 'darwin-kernel-task';
      if (!owner.kernel && owner.state !== 'Z') {
        phase = 'arguments'; const argument = args(pid); row.argv = argument.argv; if (argument.failure) row.argumentFailure = argument.failure;
        phase = 'image';
        try { row.executable = image(pid); } catch (error) { row.kernelFailure = { stage: phase + '-' + ((error as { nativeStage?: string }).nativeStage ?? 'unverified'), nativeCode: code(error) }; }
        if (!row.executable && row.kernelFailure?.stage === 'image-proc-pidpath' && [2, 3].includes(row.kernelFailure.nativeCode!)) {
          phase = 'text-regions'; row.text = readMacTextRegions(pid, (...values) => Number(info(...values)), () => koffi.errno());
        }
        phase = 'image-recheck';
        if (row.executable) assert.deepEqual(image(pid), row.executable, 'mac_process_image_changed');
        phase = 'arguments-recheck';
        if (row.argv) {
          const current = args(pid);
          if (!current.argv && current.failure?.stage === 'read' && current.failure.nativeCode === 22) row.argumentFailure = current.failure;
          else assert.ok(isDeepStrictEqual(current.argv, row.argv), 'mac_process_arguments_changed');
        }
      }
      phase = 'kinfo-recheck'; assert.deepEqual(kinfo(pid), owner, 'mac_kinfo_identity_changed');
      if (!row.executable && row.kernelFailure?.stage === 'image-proc-pidpath' && [2, 3].includes(row.kernelFailure.nativeCode!)) row.imageIdentityBound = true;
      if (row.argumentFailure?.nativeCode === 22 && (row.argumentFailure.stage === 'size' || row.argumentFailure.stage === 'read')) row.argumentFailure.identityBound = true;
      return row;
    } catch (error) {
      if (confirmMacInitialExit(row, phase, error, pid => { koffi.errno(0); const result = Number(getGroup(pid)); return { result, nativeCode: koffi.errno() }; })) {
        return { ...row, confirmedExited: 'darwin-kinfo-empty-getpgid-esrch' };
      }
      return { ...row, reason: 'mac_kernel_metadata_unverified', kernelFailure: { stage: phase, nativeCode: code(error) } };
    }
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
