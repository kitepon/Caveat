import { describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { createMacKernelReader, decodeMacArguments, decodeMacBsdInfo, decodeMacKinfoIdentity, readMacProcessArguments } from '../src/managedMacProcessNative.js';
import { isWindows } from '../src/platform.js';

describe('native process bridge and Darwin layouts', () => {
  it('loads the shipped native bridge and calls only the current process ID on each OS', async () => {
    const koffi = await import('koffi');
    const library = koffi.load(isWindows() ? 'kernel32.dll' : null);
    const getPid = library.func(isWindows() ? 'uint32_t __stdcall GetCurrentProcessId()' : 'int getpid()');
    expect(getPid()).toBe(process.pid);
  });
  it('reads only the declared argument strings and excludes the trailing environment segment', () => {
    const count = Buffer.alloc(4); count.writeInt32LE(3);
    const bytes = Buffer.concat([count, Buffer.from('/kernel/node\0\0node\0\0script.js\0SECRET_KEY=never-return-this\0')]);
    const result = decodeMacArguments(bytes);
    expect(result.argv).toEqual(['node', '', 'script.js']);
    expect(result.savedExecutable).toBe('/kernel/node');
    expect(JSON.stringify(result)).not.toContain('SECRET_KEY');
    expect(JSON.stringify(result)).not.toContain('never-return-this');
  });
  it('rejects malformed count, truncated strings and oversized kernel argument data', () => {
    const bytes = Buffer.from([255, 255, 255, 255, 1, 0]);
    expect(() => decodeMacArguments(bytes)).toThrow('mac_argument_count');
    const count = Buffer.alloc(4); count.writeInt32LE(2);
    expect(() => decodeMacArguments(Buffer.concat([count, Buffer.from('/node\0node\0unterminated')]))).toThrow('mac_argument_unterminated');
    expect(decodeMacArguments(Buffer.concat([count, Buffer.from('/node\0node\0NAME=declared-argument\0SECRET_KEY=environment\0')])).argv).toEqual(['node', 'NAME=declared-argument']);
    expect(() => decodeMacArguments(Buffer.alloc(1024 * 1024 + 1))).toThrow('mac_arguments_bound');
  });
  it('accepts the original relative execve path independently of the kernel image proof', () => {
    const count = Buffer.alloc(4); count.writeInt32LE(2);
    expect(decodeMacArguments(Buffer.concat([count, Buffer.from('node\0node\0KEY=value\0SECRET=environment\0')]))).toEqual({
      savedExecutable: 'node', argv: ['node', 'KEY=value'],
    });
  });
  it('decodes only the LP64 kinfo PID, birth and effective uid used for the foreign-owner proof', () => {
    const bytes = Buffer.alloc(648); bytes.writeInt32LE(42, 40); bytes.writeUInt32LE(501, 420);
    bytes.writeBigInt64LE(1700000000n, 0); bytes.writeInt32LE(123456, 8);
    expect(decodeMacKinfoIdentity(bytes, 42)).toEqual({ pid: 42, ppid: 0, uid: 501, birth: '1700000000:123456', state: 'live', kernel: false });
    expect(() => decodeMacKinfoIdentity(bytes, 43)).toThrow('pid_changed');
    expect(() => decodeMacKinfoIdentity(bytes.subarray(0, 640), 42)).toThrow('lp64_size');
    bytes.writeInt32LE(0, 40); bytes.writeUInt32LE(0x200, 32);
    expect(decodeMacKinfoIdentity(bytes, 0).kernel).toBe(true);
  });
  it('retains exact size-query success and real-read errno without inventing foreign-owner permission', () => {
    let calls = 0;
    const denied = readMacProcessArguments(42, (_mib, _count, bytes, length) => {
      calls++; if (!bytes) { length[0] = 128; return 0; } return -1;
    }, () => 22);
    expect(denied).toEqual({ argv: null, failure: { stage: 'read', nativeCode: 22, sizeQuerySucceeded: true } });
    expect(calls).toBe(2);
    expect(readMacProcessArguments(42, () => -1, () => 22)).toEqual({ argv: null, failure: { stage: 'size', nativeCode: 22, sizeQuerySucceeded: false } });
    expect(readMacProcessArguments(42, (_mib, _count, _bytes, length) => { length[0] = 2 ** 30; return 0; }, () => 0).failure?.stage).toBe('size-bound');
    expect(readMacProcessArguments(42, (_mib, _count, bytes, length) => { length[0] = 128; return bytes ? -1 : 0; }, () => 13).failure?.nativeCode).toBe(13);
  });
  it('checks the BSD ABI size, PID and microsecond birth instead of the process name', () => {
    const bytes = Buffer.alloc(136); bytes.writeUInt32LE(42, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(501, 20);
    bytes.writeBigUInt64LE(1700000000n, 120); bytes.writeBigUInt64LE(123456n, 128);
    expect(decodeMacBsdInfo(bytes, 42)).toEqual({ pid: 42, ppid: 1, uid: 501, birth: '1700000000:123456', state: 'live' });
    expect(() => decodeMacBsdInfo(bytes, 43)).toThrow('mac_bsd_pid_changed');
    expect(() => decodeMacBsdInfo(bytes.subarray(0, 128), 42)).toThrow('mac_bsd_info_size');
    bytes.writeBigUInt64LE(1000000n, 128);
    expect(() => decodeMacBsdInfo(bytes, 42)).toThrow('mac_process_birth_invalid');
  });
  it.skipIf(process.platform !== 'darwin')('reads the real Darwin kernel identity and argv of its own test process without enumerating other processes', async () => {
    const reader = await createMacKernelReader(), value = reader.readProcess(process.pid);
    expect(value.reason).toBeUndefined(); expect(value.pid).toBe(process.pid);
    expect(value.ppid).toBe(process.ppid); expect(value.uid).toBe(process.getuid?.());
    expect(value.executable?.path).toBe(realpathSync(process.execPath));
    expect(value.argv?.length).toBeGreaterThan(0); expect(value.birth).toMatch(/^\d+:\d+$/);
  });
});
