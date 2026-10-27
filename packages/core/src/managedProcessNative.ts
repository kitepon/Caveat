import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createMacKernelReader } from './managedMacProcessNative.js';
import { collectNativeGlobalProcesses } from './platform.js';

export type ProcessExecutable = { path: string; dev: string; ino: string };
export type NativeProcessRecord = {
  pid: number; ppid: number | null; birth: string | null; uid: number | null;
  executable: ProcessExecutable | null; argv: string[] | null; state?: string; reason?: string;
};
export type NativeProcessTables = {
  before: NativeProcessRecord[]; after: NativeProcessRecord[]; errors: string[];
  selfPid: number; selfExecutable: ProcessExecutable; caseInsensitive: boolean;
};
export type ProcessProbeEvent = { phase: string; event: 'issued' | 'started' | 'completed' | 'stopped'; pid?: number };
export type ProcessProbeRun = (command: string, args: string[], phase: string, deadline: number) => Promise<{ stdout: string; pid: number }>;

export function nativeGlobalProcessTables(onEvent: (event: ProcessProbeEvent) => void = () => {}): Promise<NativeProcessTables> {
  return collectNativeGlobalProcesses({
    linux: async () => readLinuxProcessTables(),
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
export function ownedProcessProbe(onEvent: (event: ProcessProbeEvent) => void = () => {}, options: { env?: NodeJS.ProcessEnv; cwd?: string; outputLimit?: number } = {}): ProcessProbeRun {
  return (command, args, phase, deadline) => new Promise((resolve, reject) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) { reject(Error('process_probe_deadline')); return; }
    onEvent({ phase, event: 'issued' });
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: options.env ?? { ...process.env, LC_ALL: 'C' }, ...(options.cwd ? { cwd: options.cwd } : {}) });
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
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        try { onEvent({ phase, event: 'stopped', pid: child.pid }); } catch { /* Teardown still rejects. */ }
        reject(observedFailure(Error('process_probe_close_unconfirmed', { cause: failure }), false));
      }, 1000);
    };
    const timer = setTimeout(() => stop(Error('process_probe_timeout')), timeout);
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
  return { pid, ppid, birth, state: fields[0]! };
}

function linuxRecord(procRoot: string, pid: number): NativeProcessRecord {
  const root = join(procRoot, String(pid));
  try {
    const first = parseLinuxProcessStat(bounded(join(root, 'stat'), 65536).toString('utf8'));
    assert.equal(first.pid, pid);
    const uidText = bounded(join(root, 'status'), 65536).toString('utf8').match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
    assert.ok(uidText, 'process_uid_missing');
    const uid = Number(uidText[2]);
    if (first.state === 'Z') {
      const last = parseLinuxProcessStat(bounded(join(root, 'stat'), 65536).toString('utf8'));
      assert.deepEqual(last, first, 'process_identity_changed');
      return { ...first, uid, executable: null, argv: null };
    }
    const exeFile = join(root, 'exe'), image = executable(exeFile, readlinkSync(exeFile));
    const command = bounded(join(root, 'cmdline'), 1024 * 1024);
    assert.ok(command.length > 0 && command.at(-1) === 0, 'process_argv_unavailable');
    const argv = new TextDecoder('utf-8', { fatal: true }).decode(command.subarray(0, -1)).split('\0');
    const last = parseLinuxProcessStat(bounded(join(root, 'stat'), 65536).toString('utf8'));
    assert.deepEqual({ ...last, state: first.state }, first, 'process_identity_changed');
    assert.deepEqual(executable(exeFile, readlinkSync(exeFile)), image, 'process_executable_changed');
    assert.deepEqual(bounded(join(root, 'cmdline'), 1024 * 1024), command, 'process_arguments_changed');
    return { ...first, uid, executable: image, argv };
  } catch (error) {
    return { pid, ppid: null, birth: null, uid: null, executable: null, argv: null,
      reason: (error as NodeJS.ErrnoException).code ?? 'process_metadata_unverified' };
  }
}

export function readLinuxProcessTables(procRoot = '/proc'): NativeProcessTables {
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
      return row;
    });
  };
  return { before: readTable(), after: readTable(), errors: [], selfPid: process.pid,
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
    const filtered = rows.filter(row => !owned.has(row.pid)), ids = new Set(filtered.map(row => row.pid));
    if ([...images.keys()].some(pid => !owned.has(pid) && !ids.has(pid))) errors.push('process_projection_pid_set_changed');
    return filtered.map(row => {
      if (row.reason || row.state === 'Z') return row;
      const image = row.executable;
      if (!image || !images.get(row.pid)?.some(value => value.path === image.path && value.dev === image.dev && value.ino === image.ino)) {
        return { ...row, executable: null, reason: 'kernel_text_image_unbound' };
      }
      return row;
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
$tables=@()
foreach($phase in @('before','after')){
  [Console]::Out.WriteLine('{"schema":"caveat.process_probe_phase.v1","phase":"'+$phase+'","event":"started","count":0}')
  $rows=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine -ErrorAction Stop | ForEach-Object {
    @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;birth=if($null -eq $_.CreationDate){$null}else{$_.CreationDate.ToUniversalTime().ToString('O')};exe=$_.ExecutablePath;command=$_.CommandLine}
  })
  $tables+=,@($rows)
  [Console]::Out.WriteLine('{"schema":"caveat.process_probe_phase.v1","phase":"'+$phase+'","event":"completed","count":'+$rows.Count+'}')
}
$value=@{before=$tables[0];after=$tables[1];probePid=$PID;probeBirth=$ownStart}
[Console]::Out.Write((ConvertTo-Json -InputObject $value -Depth 6 -Compress))`;

type WindowsRow = { pid: number; ppid: number; birth: string | null; exe: string | null; command: string | null };
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
    const base = { pid: row.pid, ppid: row.ppid, birth: row.birth, uid: null, executable: null, argv: null };
    if (!row.exe || !row.birth || !row.command) return { ...base, reason: 'process_metadata_unavailable' };
    try { return { ...base, executable: executable(row.exe), argv: parseWindowsProcessArguments(row.command) }; }
    catch { return { ...base, reason: 'process_metadata_unverified' }; }
  });
  const before = convert(tables.before), after = convert(tables.after);
  for (const row of before) {
    const later = after.find(value => value.pid === row.pid);
    if (later && !isDeepStrictEqual(row, later)) row.reason = 'process_identity_changed';
  }
  return { before, after, errors: [], selfPid: process.pid,
    selfExecutable: executable(process.execPath), caseInsensitive: true };
}
