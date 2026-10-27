import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { NativeProcessRecord, ProcessExecutable } from './managedProcessNative.js';

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
    birth: seconds + ':' + micros, state: bytes.readUInt32LE(4) === 5 ? 'Z' : 'live' };
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
    assert.equal(info(pid, 3, 0, buffer, buffer.length), BSD_INFO_BYTES, 'mac_process_info_unavailable');
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
  const args = (pid: number) => {
    const mib = Buffer.alloc(12); [1, 49, pid].forEach((value, index) => mib.writeInt32LE(value, index * 4));
    const length: number[] = [0];
    assert.equal(sysctl(mib, 3, null, length, null, 0), 0, 'mac_arguments_size_unavailable');
    const size = Number(length[0]);
    assert.ok(Number.isSafeInteger(size) && size >= 6 && size <= MAX_ARGUMENT_BYTES, 'mac_arguments_bound');
    const buffer = Buffer.alloc(size);
    try {
      assert.equal(sysctl(mib, 3, buffer, length, null, 0), 0, 'mac_arguments_unavailable');
      const used = Number(length[0]); assert.ok(used >= 6 && used <= buffer.length, 'mac_arguments_changed');
      return decodeMacArguments(buffer.subarray(0, used)).argv;
    } finally { buffer.fill(0); }
  };
  const readProcess = (pid: number): NativeProcessRecord => {
    try {
      const first = bsd(pid);
      if (first.state === 'Z') { assert.deepEqual(bsd(pid), first); return { ...first, executable: null, argv: null }; }
      const executable = image(pid), argv = args(pid);
      assert.deepEqual(bsd(pid), first, 'mac_process_birth_changed');
      assert.deepEqual(image(pid), executable, 'mac_process_image_changed');
      assert.ok(isDeepStrictEqual(args(pid), argv), 'mac_process_arguments_changed');
      return { ...first, executable, argv };
    } catch {
      return { pid, ppid: null, uid: null, birth: null, executable: null, argv: null, reason: 'mac_kernel_metadata_unverified' };
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
