import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createMacKernelReader } from './managedMacProcessNative.js';
import { collectNativeGlobalProcesses } from './platform.js';

export type ProcessExecutable = { path: string; dev: string; ino: string };
export type MacArgumentFailure = { stage: 'size' | 'size-bound' | 'read' | 'read-bound' | 'decode'; nativeCode: number | null; sizeQuerySucceeded: boolean; identityBound?: true; decodeReason?: string };
export type MacTextObservation = { status: 'read' | 'unreadable'; identities: { dev: string; ino: string }[]; stage: string; nativeCode: number | null };
export type NativeProcessRecord = {
  pid: number; ppid: number | null; birth: string | null; uid: number | string | null;
  executable: ProcessExecutable | null; argv: string[] | null; state?: string;
  ownerProof?: 'darwin-kinfo-proc'; imageIdentityBound?: true; text?: MacTextObservation; argumentFailure?: MacArgumentFailure; ownerFailure?: { stage: string; nativeCode: number | null }; ownerMethod?: { stage: string; returnValue: number | null }; kernelFailure?: { stage: string; nativeCode: number | null }; windowsFields?: { executable: 'present' | 'null' | 'unverified'; arguments: 'present' | 'null' | 'unverified' }; imageBinding?: 'kernel-path' | 'kernel-and-text'; kernel?: 'linux-pf-kthread' | 'darwin-kernel-task' | 'windows-kernel-process'; reason?: string;
};
/** A denied size query is usable only after kinfo has bound the call on both sides. */
export function isMacForeignArgumentDenial(row: NativeProcessRecord) {
  const failure = row.argumentFailure;
  return row.ownerProof === 'darwin-kinfo-proc' && failure?.nativeCode === 22
    && (failure.stage === 'read' && failure.sizeQuerySucceeded
      || failure.stage === 'size' && !failure.sizeQuerySucceeded && failure.identityBound === true);
}

export type NativeProcessTables = {
  before: NativeProcessRecord[]; after: NativeProcessRecord[]; errors: string[];
  selfPid: number; selfExecutable: ProcessExecutable; caseInsensitive: boolean; confirmedExitedDuringRead?: number;
};
export type ProcessProbeEvent = { phase: string; event: 'issued' | 'started' | 'completed' | 'stopped'; pid?: number };
export type ProcessProbeRun = (command: string, args: string[], phase: string, deadline: number) => Promise<{ stdout: string; pid: number }>;

export function nativeGlobalProcessTables(onEvent: (event: ProcessProbeEvent) => void = () => {}): Promise<NativeProcessTables> {
  return collectNativeGlobalProcesses({
    linux: async () => {
      assert.equal(readlinkSync('/proc/self'), String(process.pid), 'process_procfs_namespace_unbound');
      const koffi = await import('koffi'), getGroup = koffi.load(null).func('int getpgid(int pid)');
      return readLinuxProcessTables('/proc', pid => { koffi.errno(0); return Number(getGroup(pid)) === -1 && koffi.errno() === 3; });
    },
    darwin: () => readMacProcessTables(ownedProcessProbe(onEvent)),
    win32: command => readWindowsProcessTables(command, ownedProcessProbe(onEvent)),
  });
}

function bounded(file: string, limit: number) {
  const fd = openSync(file, 'r'), chunks: Buffer[] = [], buffer = Buffer.alloc(Math.min(limit + 1, 65536));
  let total = 0;
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, limit - total + 1), null);
      if (!n) break;
      total += n; assert.ok(total <= limit, 'process_metadata_bound');
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    return Buffer.concat(chunks);
  } finally { closeSync(fd); }
}
function executable(file: string, path = file): ProcessExecutable {
  const stat = statSync(file, { bigint: true });
  assert.ok(stat.isFile(), 'process_executable_nonregular');
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}

/** Only the child created here may be terminated. Close, not exit, completes the probe. */
export function ownedProcessProbe(onEvent: (event: ProcessProbeEvent) => void = () => {}, options: { env?: NodeJS.ProcessEnv; cwd?: string; outputLimit?: number; input?: Buffer } = {}): ProcessProbeRun {
  return (command, args, phase, deadline) => new Promise((resolve, reject) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) { reject(Error('process_probe_deadline')); return; }
    if (options.input && options.input.length > 8 * 1024 * 1024) { reject(Error('process_probe_input_bound')); return; }
    onEvent({ phase, event: 'issued' });
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: options.env ?? { ...process.env, LC_ALL: 'C' }, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const chunks: Buffer[] = []; let size = 0, failure: Error | undefined, settled = false, progress = '', spawned = false, exited = false, terminationRequested = false;
    const observedFailure = (error: Error, closed: boolean) => Object.assign(error, { ownedProbe: {
      pid: child.pid ?? null, spawned, exitObserved: child.exitCode !== null || child.signalCode !== null,
      closeObserved: closed, terminationRequested,
    } });
    let teardown: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (settled || teardown) return;
      failure ??= error; terminationRequested = true; child.kill();
      teardown = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdin?.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        try { onEvent({ phase, event: 'stopped', pid: child.pid }); } catch { /* Teardown still rejects. */ }
        reject(observedFailure(Error('process_probe_close_unconfirmed', { cause: failure }), false));
      }, 1000);
    };
    const timer = setTimeout(() => stop(Error('process_probe_timeout')), timeout);
    child.stdin.on('error', () => stop(Error('process_probe_input_failed'))); child.stdin.end(options.input);
    const emit = (value: ProcessProbeEvent) => {
      try { onEvent(value); }
      catch { stop(Error('process_probe_receipt_failed')); }
    };
    child.on('spawn', () => { spawned = true; emit({ phase, event: 'started', pid: child.pid }); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || failure) return;
      size += chunk.length;
      if (size > (options.outputLimit ?? 16 * 1024 * 1024)) stop(Error('process_probe_output_bound'));
      else {
        chunks.push(chunk);
        if (phase === 'cim') {
          progress += chunk.toString('utf8');
          let end: number;
          while (!failure && (end = progress.indexOf('\n')) >= 0) {
            const line = progress.slice(0, end); progress = progress.slice(end + 1);
            if (line.length > 2048) continue;
            try {
              const frame: unknown = JSON.parse(line);
              if (isProcessProgress(frame)) emit({ phase: 'cim:' + frame.phase, event: frame.event, pid: child.pid });
            } catch { /* The complete bounded protocol is validated after close. */ }
          }
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > (options.outputLimit ?? 16 * 1024 * 1024)) stop(Error('process_probe_output_bound')); });
    child.on('error', () => { failure ??= Error('process_probe_spawn_failed'); });
    child.on('exit', () => { exited = true; });
    child.on('close', code => {
      clearTimeout(timer);
      if (teardown) clearTimeout(teardown);
      if (settled) return;
      settled = true;
      if (failure || code !== 0 || child.pid === undefined || !spawned || !exited) {
        try { onEvent({ phase, event: 'stopped', pid: child.pid }); } catch { /* The original failure remains primary. */ }
        reject(observedFailure(failure ?? Error('process_probe_exit_failed'), true));
      } else {
        let stdout: string;
        try { stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { reject(observedFailure(Error('process_probe_invalid_utf8'), true)); return; }
        try { onEvent({ phase, event: 'completed', pid: child.pid }); }
        catch { reject(observedFailure(Error('process_probe_receipt_failed'), true)); return; }
        resolve({ stdout, pid: child.pid });
      }
    });
  });
}

type ProcessProgress = { schema: 'caveat.process_probe_phase.v1'; phase: 'bootstrap' | 'before' | 'after'; event: 'started' | 'completed'; count: number };
function isProcessProgress(value: unknown): value is ProcessProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'count,event,phase,schema'
    && row.schema === 'caveat.process_probe_phase.v1' && ['bootstrap', 'before', 'after'].includes(String(row.phase))
    && ['started', 'completed'].includes(String(row.event)) && Number.isSafeInteger(row.count) && Number(row.count) >= 0 && Number(row.count) <= 100000;
}

export function parseLinuxProcessStat(text: string) {
  const end = text.lastIndexOf(')'), start = text.indexOf(' (');
  assert.ok(start > 0 && end > start, 'invalid_process_stat');
  const pid = Number(text.slice(0, start)), fields = text.slice(end + 2).trim().split(/\s+/);
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && fields.length >= 20, 'invalid_process_stat');
  const ppid = Number(fields[1]), birth = fields[19]!;
  assert.ok(Number.isSafeInteger(ppid) && ppid >= 0 && /^\d+$/.test(birth), 'invalid_process_stat');
  assert.match(fields[6]!, /^\d+$/, 'invalid_process_flags');
  return { pid, ppid, birth, state: fields[0]!, ...(BigInt(fields[6]!) & 0x00200000n ? { kernel: 'linux-pf-kthread' as const } : {}) };
}

function linuxRecord(procRoot: string, pid: number): NativeProcessRecord {
  const root = join(procRoot, String(pid));
  let row: NativeProcessRecord = { pid, ppid: null, birth: null, uid: null, executable: null, argv: null };
  try {
    const first = parseLinuxProcessStat(bounded(join(root, 'stat'), 65536).toString('utf8'));
    assert.equal(first.pid, pid); row = { ...row, ...first };
    const uidText = bounded(join(root, 'status'), 65536).toString('utf8').match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
    assert.ok(uidText, 'process_uid_missing'); row.uid = Number(uidText[2]);
    if (!first.kernel && first.state !== 'Z') {
      const command = () => {
        const bytes = bounded(join(root, 'cmdline'), 1024 * 1024);
        assert.ok(bytes.length > 0 && bytes.at(-1) === 0, 'process_argv_unavailable');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)).split('\0');
      };
      try { row.argv = command(); } catch { /* Preserve owner/birth independently from unreadable argv. */ }
      const exe = () => executable(join(root, 'exe'), readlinkSync(join(root, 'exe')));
      try { row.executable = exe(); } catch { /* A foreign uid can deny exe while retaining readable argv. */ }
      if (row.argv) assert.deepEqual(command(), row.argv, 'process_arguments_changed');
      if (row.executable) assert.deepEqual(exe(), row.executable, 'process_executable_changed');
    }
    const last = parseLinuxProcessStat(bounded(join(root, 'stat'), 65536).toString('utf8'));
    assert.deepEqual({ ...last, state: first.state }, first, 'process_identity_changed');
    return row;
  } catch (error) {
    return { ...row, reason: (error as NodeJS.ErrnoException).code ?? 'process_metadata_unverified' };
  }
}

export function readLinuxProcessTables(procRoot = '/proc', exited: (pid: number) => boolean = () => false): NativeProcessTables {
  let confirmedExitedDuringRead = 0;
  const deadline = Date.now() + 20000;
  const readTable = () => {
    const pids = readdirSync(procRoot).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
    assert.ok(pids.length > 0 && pids.length <= 100000, 'process_table_bound');
    let total = 0;
    return pids.map(pid => {
      assert.ok(Date.now() <= deadline, 'process_probe_deadline');
      const row = linuxRecord(procRoot, pid);
      total += Buffer.byteLength(JSON.stringify(row));
      assert.ok(total <= 16 * 1024 * 1024, 'process_table_byte_bound');
      if ((row.reason === 'ENOENT' || !row.argv || !row.executable) && Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff && exited(pid)) { confirmedExitedDuringRead++; return null; }
      return row;
    }).filter((row): row is NativeProcessRecord => row !== null);
  };
  const before = readTable(), after = readTable();
  return { before, after, errors: [], selfPid: process.pid, confirmedExitedDuringRead,
    selfExecutable: executable(process.execPath), caseInsensitive: false };
}

/** Windows command lines are not shell programs; backslashes only escape quotes in a quoted argument. */
export function parseWindowsProcessArguments(text: string): string[] {
  assert.ok(text.length <= 1024 * 1024 && !text.includes('\0'), 'process_commandline_bound');
  const result: string[] = []; let index = 0;
  while (index < text.length) {
    while (/[ \t]/.test(text[index] ?? '') && index < text.length) index++;
    if (index === text.length) break;
    let value = '', quoted = false;
    while (index < text.length) {
      if (!quoted && /[ \t]/.test(text[index]!)) break;
      let backslashes = 0;
      while (text[index] === '\\') { backslashes++; index++; }
      if (text[index] === '"') {
        value += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2) value += '"';
        else if (quoted && text[index + 1] === '"') { value += '"'; index++; }
        else quoted = !quoted;
        index++;
      } else {
        value += '\\'.repeat(backslashes);
        if (!quoted && /[ \t]/.test(text[index] ?? '')) break;
        if (index < text.length) value += text[index++]!;
      }
    }
    assert.ok(!quoted, 'process_commandline_unterminated_quote');
    result.push(value);
    assert.ok(result.length <= 65536, 'process_argument_count_bound');
  }
  return result;
}

/** NUL fields preserve spaces; a txt name alone never establishes executable identity. */
export function parseMacTextImages(text: string) {
  const rows = new Map<number, ProcessExecutable[]>();
  let pid: number | undefined, fd: string | undefined, image: Partial<ProcessExecutable> = {};
  const flush = () => {
    if (pid !== undefined && fd === 'txt' && image.path && image.dev && image.ino) rows.get(pid)!.push(image as ProcessExecutable);
    image = {}; fd = undefined;
  };
  for (const field of text.split('\0')) {
    const token = field.replace(/^\n/, '');
    if (!token) continue;
    const value = token.slice(1);
    if (token[0] === 'p') {
      flush(); assert.match(value, /^\d+$/); pid = Number(value);
      assert.ok(Number.isSafeInteger(pid) && !rows.has(pid), 'invalid_lsof_pid'); rows.set(pid, []);
    } else if (token[0] === 'f') { flush(); assert.ok(pid !== undefined, 'lsof_process_missing'); fd = value; }
    else if (token[0] === 'D') { assert.match(value, /^0x[0-9a-f]+$/i); image.dev = String(BigInt(value)); }
    else if (token[0] === 'i') { assert.match(value, /^[1-9]\d*$/); image.ino = value; }
    else if (token[0] === 'n') { assert.ok(value.startsWith('/') && !/[\r\n]/.test(value), 'invalid_lsof_path'); image.path = value; }
    else assert.fail('unexpected_lsof_field');
  }
  flush(); return rows;
}

export async function readMacProcessTables(run: ProcessProbeRun, kernelTable?: (deadline: number) => NativeProcessRecord[]): Promise<NativeProcessTables> {
  const readTable = kernelTable ?? (await createMacKernelReader()).readTable;
  const deadline = Date.now() + 20000, owned = new Map<number, string>();
  const capture = async (phase: string) => {
    const result = await run('/usr/sbin/lsof', ['-n', '-P', '-d', 'txt', '-F0pfDin'], phase, deadline);
    owned.set(result.pid, '/usr/sbin/lsof'); return parseMacTextImages(result.stdout);
  };
  const before = readTable(deadline), imagesBefore = await capture('images-before');
  const imagesAfter = await capture('images-after'), after = readTable(deadline);
  const errors: string[] = [];
  for (const rows of [before, after]) for (const row of rows) {
    if (!owned.has(row.pid)) continue;
    try { assert.ok(row.ppid === process.pid && row.executable?.path === realpathSync(owned.get(row.pid)!)); }
    catch { errors.push('owned_probe_identity_changed'); }
  }
  const convert = (rows: NativeProcessRecord[], images: Map<number, ProcessExecutable[]>) => {
    // lsof corroborates executable identity; the two kernel tables define the observation scope.
    const filtered = rows.filter(row => !owned.has(row.pid));
    return filtered.map(row => {
      if (row.reason || row.state === 'Z' || row.kernel || row.imageIdentityBound && !row.executable) return row;
      const image = row.executable;
      if (!image || !images.get(row.pid)?.some(value => value.path === image.path && value.dev === image.dev && value.ino === image.ino)) {
        const callerUid = before.find(value => value.pid === process.pid)?.uid;
        if (image && typeof callerUid === 'number' && callerUid !== 0 && typeof row.uid === 'number' && row.uid !== callerUid
          && row.ownerProof === 'darwin-kinfo-proc' && (row.argv || isMacForeignArgumentDenial(row))) {
          return { ...row, imageBinding: 'kernel-path' as const };
        }
        return { ...row, executable: null, ...(row.uid === callerUid ? { reason: 'kernel_text_image_unbound' } : {}) };
      }
      return { ...row, imageBinding: 'kernel-and-text' as const };
    });
  };
  return { before: convert(before, imagesBefore), after: convert(after, imagesAfter), errors,
    selfPid: process.pid, selfExecutable: executable(realpathSync(process.execPath)), caseInsensitive: false };
}

// Privilege elevation and SeDebugPrivilege enablement are deliberately absent.
export const WINDOWS_PROCESS_PROBE = String.raw`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::Out.WriteLine('{"schema":"caveat.process_probe_phase.v1","phase":"bootstrap","event":"started","count":0}')
Import-Module CimCmdlets -ErrorAction Stop
$current=[Diagnostics.Process]::GetCurrentProcess()
$ownStart=$current.StartTime.ToUniversalTime().ToString('O')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class CaveatProcessOwner {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  public sealed class Result { public string Sid; public string Stage; public int Code; public Result(string sid, string stage, int code) { Sid=sid; Stage=stage; Code=code; } }
  static Result Failed(string stage, int code) { return new Result(null, stage, code); }
  public static Result Read(int pid, long expectedBirth) {
    IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
    if (process == IntPtr.Zero) return Failed("process-open", Marshal.GetLastWin32Error());
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) return Failed("process-times", Marshal.GetLastWin32Error());
      if (Math.Abs(created - expectedBirth) > 9) return Failed("birth", 0);
      if (!OpenProcessToken(process, 8, out token)) return Failed("token-open", Marshal.GetLastWin32Error());
      using (WindowsIdentity identity = new WindowsIdentity(token)) { return new Result(identity.User.Value, "known", 0); }
    } catch (Exception error) { return Failed("token-sid", error.HResult); }
    finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
  }
}
'@
$tables=@()
foreach($phase in @('before','after')){
  [Console]::Out.WriteLine('{"schema":"caveat.process_probe_phase.v1","phase":"'+$phase+'","event":"started","count":0}')
  $ownerBudget=16
  $rows=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine -ErrorAction Stop | Sort-Object ProcessId | ForEach-Object {
    $owner=if($null -eq $_.CreationDate){[pscustomobject]@{Sid=$null;Stage='birth-missing';Code=0}}else{[CaveatProcessOwner]::Read([int]$_.ProcessId,$_.CreationDate.ToUniversalTime().ToFileTimeUtc())}
    $sid=$owner.Sid;$methodStage='not-attempted';$methodReturn=$null
    if($null -eq $sid -and $ownerBudget -gt 0 -and $_.ProcessId -gt 4 -and $null -ne $_.CreationDate){
      $ownerBudget--
      try {
        $method=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction Stop
        $methodReturn=[int]$method.ReturnValue
        if($methodReturn -eq 0 -and $method.Sid -match '^S-1-(?:[0-9]+-)*[0-9]+$'){
          $again=[CaveatProcessOwner]::Read([int]$_.ProcessId,$_.CreationDate.ToUniversalTime().ToFileTimeUtc())
          if(($again.Stage -eq 'known' -and $again.Sid -eq $method.Sid) -or $again.Stage -eq 'token-open'){$sid=$method.Sid;$methodStage='known'}elseif($again.Stage -eq 'known'){$methodStage='owner-changed'}else{$methodStage='birth-unconfirmed'}
        }else{$methodStage='denied'}
      }catch{$methodStage='unavailable'}
    }
    @{uid=$sid;ownerStage=$owner.Stage;ownerError=[int]$owner.Code;ownerMethodStage=$methodStage;ownerMethodReturn=$methodReturn;pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;birth=if($null -eq $_.CreationDate){$null}else{$_.CreationDate.ToUniversalTime().ToString('O')};exe=$_.ExecutablePath;command=$_.CommandLine}
  })
  $tables+=,@($rows)
  [Console]::Out.WriteLine('{"schema":"caveat.process_probe_phase.v1","phase":"'+$phase+'","event":"completed","count":'+$rows.Count+'}')
}
$value=@{before=$tables[0];after=$tables[1];probePid=$PID;probeBirth=$ownStart}
[Console]::Out.Write((ConvertTo-Json -InputObject $value -Depth 6 -Compress))`;

type WindowsRow = { uid: string | null; ownerStage?: string; ownerError?: number; ownerMethodStage?: string; ownerMethodReturn?: number | null; pid: number; ppid: number; birth: string | null; exe: string | null; command: string | null };
export function decodeWindowsProcessTables(text: string, ownedPid: number): { before: WindowsRow[]; after: WindowsRow[]; probeBirth: string } {
  const lines = text.trim().split(/\r?\n/);
  assert.equal(lines.length, 6, 'process_probe_frame_count');
  const events: ProcessProgress[] = [];
  const expected = ['bootstrap:started', 'before:started', 'before:completed', 'after:started', 'after:completed'];
  for (const [index, line] of lines.slice(0, -1).entries()) {
    const frame: unknown = JSON.parse(line); assert.ok(isProcessProgress(frame), 'invalid_process_probe_frame');
    assert.equal(frame.phase + ':' + frame.event, expected[index], 'process_probe_frame_order'); events.push(frame);
  }
  const doc = JSON.parse(lines.at(-1)!) as { before: WindowsRow[]; after: WindowsRow[]; probePid: number; probeBirth: string };
  assert.ok(doc && doc.probePid === ownedPid && typeof doc.probeBirth === 'string' && !Number.isNaN(Date.parse(doc.probeBirth)), 'process_probe_binding');
  for (const table of [doc.before, doc.after]) {
    assert.ok(Array.isArray(table) && table.length > 0 && table.length <= 100000, 'process_table_bound');
    const ids = new Set<number>();
    for (const row of table) {
      assert.ok(Number.isSafeInteger(row.pid) && row.pid >= 0 && !ids.has(row.pid), 'invalid_process_pid'); ids.add(row.pid);
      assert.ok(Number.isSafeInteger(row.ppid) && row.ppid >= 0, 'invalid_process_parent');
      assert.ok(row.birth === null || typeof row.birth === 'string' && !Number.isNaN(Date.parse(row.birth)), 'invalid_process_birth');
      if (row.ownerStage !== undefined) {
        assert.ok(['known', 'birth-missing', 'process-open', 'process-times', 'birth', 'token-open', 'token-sid'].includes(row.ownerStage)
          && Number.isSafeInteger(row.ownerError), 'invalid_process_owner_diagnostic');
        assert.ok(['not-attempted', 'known', 'denied', 'birth-unconfirmed', 'owner-changed', 'unavailable'].includes(row.ownerMethodStage!)
          && (row.ownerMethodReturn === null || Number.isSafeInteger(row.ownerMethodReturn)), 'invalid_process_owner_method_diagnostic');
        if (row.uid !== null) assert.ok(row.ownerStage === 'known' || row.ownerMethodStage === 'known' && row.ownerMethodReturn === 0, 'process_owner_proof_missing');
        if (row.ownerStage === 'known') assert.ok(row.uid !== null && row.ownerError === 0, 'process_owner_proof_missing');
      }
      assert.ok(row.uid === null || typeof row.uid === 'string' && /^S-1-(?:\d+-)*\d+$/.test(row.uid), 'invalid_process_owner');
      assert.ok(row.exe === null || typeof row.exe === 'string', 'invalid_process_executable');
      assert.ok(row.command === null || typeof row.command === 'string', 'invalid_process_command');
    }
    const probe = table.find(row => row.pid === ownedPid);
    assert.ok(probe && probe.ppid === process.pid && Date.parse(probe.birth ?? '') === Date.parse(doc.probeBirth), 'process_probe_binding');
  }
  assert.equal(events[2]!.count, doc.before.length, 'process_probe_count_mismatch');
  assert.equal(events[4]!.count, doc.after.length, 'process_probe_count_mismatch');
  return doc;
}

export async function readWindowsProcessTables(command: string, run: ProcessProbeRun): Promise<NativeProcessTables> {
  const result = await run(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PROCESS_PROBE, 'utf16le').toString('base64')], 'cim', Date.now() + 20000);
  const tables = decodeWindowsProcessTables(result.stdout, result.pid);
  const convert = (rows: WindowsRow[]): NativeProcessRecord[] => rows.filter(row => row.pid !== result.pid).map(row => {
    const base: NativeProcessRecord = { pid: row.pid, ppid: row.ppid, birth: row.birth, uid: row.uid, executable: null, argv: null,
      ...(row.ownerStage && row.ownerStage !== 'known' ? { ownerFailure: { stage: row.ownerStage, nativeCode: row.ownerError ?? null } } : {}),
      ...(row.ownerMethodStage && row.ownerMethodStage !== 'not-attempted' ? { ownerMethod: { stage: row.ownerMethodStage, returnValue: row.ownerMethodReturn ?? null } } : {}) };
    // Windows reserves these process IDs for kernel work; never infer this from the image name.
    if ((row.pid === 0 || row.pid === 4) && row.ppid === 0 && !row.exe && !row.command) {
      return { ...base, birth: row.birth ?? 'windows-idle-boot', kernel: 'windows-kernel-process' };
    }
    base.windowsFields = { executable: row.exe ? 'present' : 'null', arguments: row.command ? 'present' : 'null' };
    if (row.command) try { base.argv = parseWindowsProcessArguments(row.command); } catch { base.windowsFields.arguments = 'unverified'; return { ...base, reason: 'process_arguments_unverified' }; }
    if (row.exe) try { base.executable = executable(row.exe); } catch { base.windowsFields.executable = 'unverified'; }
    return base;
  });
  const before = convert(tables.before), after = convert(tables.after);
  return { before, after, errors: [], selfPid: process.pid,
    selfExecutable: executable(process.execPath), caseInsensitive: true };
}
