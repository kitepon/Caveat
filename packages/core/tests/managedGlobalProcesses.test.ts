import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessGlobalProcesses, preflightGlobalProcesses } from '../src/managedGlobalProcesses.js';
import { decodeWindowsProcessTables, ownedProcessProbe, parseLinuxProcessStat, parseWindowsProcessArguments, parseMacTextImages, readLinuxProcessTables, readMacProcessTables, WINDOWS_PROCESS_PROBE, type NativeProcessRecord, type NativeProcessTables, type ProcessProbeEvent } from '../src/managedProcessNative.js';
import { globalNpmEnvironment, isWindows, quoteWindowsArgument } from '../src/platform.js';

const scope = { packageRoot: '/global/node_modules/caveat-cli', npmRoot: '/runtime/npm', binAliases: ['/global/bin/caveat'] };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function record(pid: number, image = '/usr/bin/native-tool', argv = [image]): NativeProcessRecord {
  return { pid, ppid: 1, birth: '1234', uid: 1000, executable: { path: image, dev: '1', ino: String(pid + 100) }, argv, state: 'S' };
}
function tables(...others: NativeProcessRecord[]): NativeProcessTables {
  const self = record(10, '/runtime/node', ['/runtime/node', '/managed/entry', 'deployment']);
  return { before: [self, ...others], after: structuredClone([self, ...others]), errors: [], selfPid: 10,
    selfExecutable: self.executable!, caseInsensitive: false };
}
describe('global process assessment', () => {
  it('allows normal, unreadable, foreign, changed and short-lived entries', () => {
    const value = tables(record(20), { ...record(21), argv: null, executable: null, reason: 'EACCES' }, { ...record(22), uid: 2000 }, { ...record(23), state: 'Z', argv: null, executable: null });
    value.after = value.after.filter(row => row.pid !== 22); value.after[1]!.birth = 'changed';
    expect(assessGlobalProcesses(scope, value)).toMatchObject({ status: 'ready', counts: { unreadable: 2, foreign: 1, kernel: 1, shortLived: 1 }, records: [] });
  });
  it('shows consumer PID and parent app, and becomes ready after close', () => {
    const value = tables(record(1, '/Applications/Codex.app/codex'), record(20, '/runtime/node', ['node', scope.packageRoot + '/dist/caveat.js', 'mcp-server']));
    expect(assessGlobalProcesses(scope, value)).toMatchObject({ status: 'stopped', consumers: 1,
      records: [{ pid: 20, parentPid: 1, parentApp: 'Codex', resolution: { action: 'close-process', instruction: expect.stringContaining('PID 20') } }] });
    value.before = value.before.filter(row => row.pid !== 20); value.after = value.after.filter(row => row.pid !== 20);
    expect(assessGlobalProcesses(scope, value).status).toBe('ready');
  });
  it('uses readable references even when owner, image or the other observation is missing', () => {
    const value = tables({ ...record(20), argv: ['node', scope.packageRoot + '/index.js'], uid: null, executable: null }); value.before.pop();
    expect(assessGlobalProcesses(scope, value)).toMatchObject({ status: 'stopped', consumers: 1 });
  });
  it('ignores neighbouring package, ordinary Node, journal and protected data paths', () => {
    const expanded = { ...scope, protectedPaths: ['/managed/entry', '/home/.claude.json'] };
    expect(assessGlobalProcesses(expanded, tables(record(20, '/runtime/node', ['node', '/other.js', scope.packageRoot + '-other/index.js', '/journal/file', '/managed/entry']))).status).toBe('ready');
  });
  it('stops only a readable npm writer targeting the old global', () => {
    const npm = ['node', scope.npmRoot + '/bin/npm-cli.js', 'uninstall', '-g'];
    expect(assessGlobalProcesses(scope, tables(record(20, '/runtime/node', [...npm, 'other-package']))).status).toBe('ready');
    expect(assessGlobalProcesses(scope, tables(record(20, '/runtime/node', [...npm, 'caveat-cli'])))).toMatchObject({ status: 'stopped', writers: 1, records: [{ resolution: { action: 'finish-npm-operation' } }] });
  });
  it('detects readable Claude Code writers for configuration migration', () => {
    const config = { binAliases: [], protectedPaths: ['/profile/.claude.json'] };
    expect(assessGlobalProcesses(config, tables(record(20, '/usr/bin/node', ['node', '/npm/@anthropic-ai/claude-code/cli.js'])))).toMatchObject({ status: 'stopped', writers: 1, records: [{ reason: 'claude_config_writer' }] });
    expect(assessGlobalProcesses(config, tables({ ...record(20), argv: null }))).toMatchObject({ status: 'ready' });
  });
  it('counts an old consumer that has already exited without stopping', () => {
    const value = tables(record(20, '/runtime/node', ['node', scope.packageRoot + '/index.js'])); value.after.pop();
    expect(assessGlobalProcesses(scope, value)).toMatchObject({ status: 'ready', counts: { shortLived: 1 }, records: [] });
  });
  it('validates scope and reports whole collection failures separately', async () => {
    await expect(preflightGlobalProcesses({ ...scope, packageRoot: '/global/../elsewhere' }, () => {}, async () => tables())).rejects.toThrow('absolute_process_scope_required');
    expect(await preflightGlobalProcesses(scope, () => {}, async () => { throw Error('fixture'); })).toMatchObject({ status: 'stopped', errors: ['native_process_collection_failed'] });
  });
});

describe('native process parsers and owned transport', () => {
  it('reads Linux start ticks after a comm containing spaces and parentheses', () => {
    const fields = ['S', '1', ...Array(17).fill('0'), '987654', ...Array(30).fill('0')];
    expect(parseLinuxProcessStat('123 (misleading ) name) ' + fields.join(' '))).toEqual({ pid: 123, ppid: 1, birth: '987654', state: 'S' });
    expect(() => parseLinuxProcessStat('123 unbound')).toThrow('invalid_process_stat');
  });
  it.skipIf(isWindows())('reads a bounded owned procfs fixture twice and keeps missing executable data unknown', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-procfs-'))); roots.push(root);
    const proc = join(root, String(process.pid)); mkdirSync(proc);
    const fields = ['S', '1', ...Array(17).fill('0'), '987654', ...Array(30).fill('0')];
    writeFileSync(join(proc, 'stat'), process.pid + ' (fixture name) ' + fields.join(' '));
    writeFileSync(join(proc, 'status'), 'Uid:\t1000\t1000\t1000\t1000\n');
    symlinkSync(process.execPath, join(proc, 'exe'));
    writeFileSync(join(proc, 'cmdline'), Buffer.from(process.execPath + '\0private-fixture-argument\0'));
    const value = readLinuxProcessTables(root);
    expect(value.before).toEqual(value.after); expect(assessGlobalProcesses(scope, value).status).toBe('ready');
    rmSync(join(proc, 'cmdline'));
    const missing = assessGlobalProcesses(scope, readLinuxProcessTables(root));
    expect(missing.status).toBe('ready'); expect(missing.unknown).toBe(0);
  });
  it('roundtrips Windows CreateProcess argument quoting including Unicode and trailing slashes', () => {
    const argv = ['C:\\Program Files\\node.exe', 'C:\\作業\\entry.js', '', 'space value', 'trailing\\', 'quote"value', '\\"', 'a\\\\"b'];
    expect(parseWindowsProcessArguments(argv.map(quoteWindowsArgument).join(' '))).toEqual(argv);
    expect(parseWindowsProcessArguments('program tail\\ next\tvalue')).toEqual(['program', 'tail\\', 'next', 'value']);
    expect(parseWindowsProcessArguments('program non\u00a0breaking')).toEqual(['program', 'non\u00a0breaking']);
    expect(() => parseWindowsProcessArguments('"unterminated')).toThrow('unterminated_quote');
  });
  it('requires CIM child PID/parent/birth binding and rejects duplicate or missing table entries', () => {
    const row = { uid: 'S-1-5-21-1000' as string | null, pid: 99999, ppid: process.pid, birth: '2026-01-01T00:00:00.000Z', exe: 'C:\\Windows\\probe.exe', command: 'probe' };
    const doc = { before: [row], after: [row], probePid: row.pid, probeBirth: row.birth };
    const frames = (value: typeof doc) => [
      ['bootstrap', 'started', 0], ['before', 'started', 0], ['before', 'completed', value.before.length], ['after', 'started', 0], ['after', 'completed', value.after.length],
    ].map(([phase, event, count]) => JSON.stringify({ schema: 'caveat.process_probe_phase.v1', phase, event, count })).join('\n') + '\n' + JSON.stringify(value);
    expect(decodeWindowsProcessTables(frames(doc), row.pid).before).toHaveLength(1);
    const diagnostic = { ...row, uid: null, ownerStage: 'token-open', ownerError: 5, ownerMethodStage: 'denied', ownerMethodReturn: 2 };
    expect(decodeWindowsProcessTables(frames({ ...doc, before: [diagnostic], after: [diagnostic] }), row.pid).before[0]?.ownerError).toBe(5);
    expect(() => decodeWindowsProcessTables(frames({ ...doc, before: [{ ...diagnostic, uid: row.uid }], after: [diagnostic] }), row.pid)).toThrow('owner_proof_missing');
    expect(() => decodeWindowsProcessTables(frames({ ...doc, before: [{ ...diagnostic, ownerStage: 'private-arbitrary-text' }], after: [diagnostic] }), row.pid)).toThrow('owner_diagnostic');
    expect(() => decodeWindowsProcessTables(frames(doc), row.pid + 1)).toThrow('process_probe_binding');
    expect(() => decodeWindowsProcessTables(frames({ ...doc, after: [row, row] }), row.pid)).toThrow('invalid_process_pid');
    expect(() => decodeWindowsProcessTables(frames({ ...doc, after: [] }), row.pid)).toThrow('process_table_bound');
    expect(() => decodeWindowsProcessTables(JSON.stringify(doc), row.pid)).toThrow('process_probe_frame_count');
  });
  it('reports start and close for its own child without exposing stderr', async () => {
    const events: ProcessProbeEvent[] = [];
    const result = await ownedProcessProbe(event => events.push(event))(process.execPath, ['-e', 'process.stderr.write("not-public");process.stdout.write("fixture")'], 'fixture', Date.now() + 5000);
    expect(result.stdout).toBe('fixture'); expect(result.pid).toBeGreaterThan(0);
    expect(events.map(({ phase, event }) => ({ phase, event }))).toEqual([{ phase: 'fixture', event: 'issued' }, { phase: 'fixture', event: 'started' }, { phase: 'fixture', event: 'completed' }]);
  });
  it('awaits pipe closure after the direct child exits', async () => {
    const descendant = 'setTimeout(()=>process.stdout.write("after-parent-exit"),300)';
    const parent = 'require("node:child_process").spawn(process.execPath,["-e",' + JSON.stringify(descendant) + '],{stdio:["ignore",1,2],detached:true,windowsHide:true}).unref()';
    const result = await ownedProcessProbe()(process.execPath, ['-e', parent], 'fixture', Date.now() + 5000);
    expect(result.stdout).toBe('after-parent-exit');
  });
  it('streams only validated public phase frames while retaining the final private payload separately', async () => {
    const frame = { schema: 'caveat.process_probe_phase.v1', phase: 'before', event: 'completed', count: 1 };
    const code = 'process.stdout.write(' + JSON.stringify(JSON.stringify(frame) + '\n') + ');setTimeout(()=>process.stdout.write("private-payload"),100)';
    const events: ProcessProbeEvent[] = [];
    const result = await ownedProcessProbe(value => events.push(value))(process.execPath, ['-e', code], 'cim', Date.now() + 5000);
    expect(events.map(value => value.phase + ':' + value.event)).toEqual(['cim:issued', 'cim:started', 'cim:before:completed', 'cim:completed']);
    expect(result.stdout).toContain('private-payload'); expect(JSON.stringify(events)).not.toContain('private-payload');
  });
  it('passes bounded private UTF-8 input through an owned pipe without adding it to argv', async () => {
    const input = Buffer.from(JSON.stringify({ files: ['C:\\非ASCII\\private.js'] }));
    const result = await ownedProcessProbe(() => {}, { input })(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'fixture', Date.now() + 5000);
    expect(result.stdout).toBe(input.toString());
    await expect(ownedProcessProbe(() => {}, { input: Buffer.alloc(8 * 1024 * 1024 + 1) })(process.execPath, [], 'fixture', Date.now() + 5000)).rejects.toThrow('process_probe_input_bound');
  });
  it('bounds a hung child and never retries it', async () => {
    const events: ProcessProbeEvent[] = [];
    await expect(ownedProcessProbe(event => events.push(event))(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 'fixture', Date.now() + 300)).rejects.toThrow('process_probe_timeout');
    expect(events.map(({ phase, event }) => ({ phase, event }))).toEqual([{ phase: 'fixture', event: 'issued' }, { phase: 'fixture', event: 'started' }, { phase: 'fixture', event: 'stopped' }]);
  });
  it('rejects oversized output without retaining it as metadata', async () => {
    await expect(ownedProcessProbe()(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(17*1024*1024,97))'], 'fixture', Date.now() + 5000)).rejects.toThrow('process_probe_output_bound');
  });
  it('bounds stderr too when running the restricted Node capability probe', async () => {
    await expect(ownedProcessProbe(() => {}, { env: globalNpmEnvironment(process.execPath, tmpdir()), outputLimit: 1024 })(process.execPath,
      ['-e', 'process.stderr.write(Buffer.alloc(2048,97))'], 'node-capability', Date.now() + 5000)).rejects.toThrow('process_probe_output_bound');
  });
  it('requires lsof txt device/inode fields and preserves spaces in executable names', () => {
    const images = parseMacTextImages('p20\0\nftxt\0D0x100\0i777\0n/space path/native\0\n');
    expect(images.get(20)).toEqual([{ path: '/space path/native', dev: '256', ino: '777' }]);
    expect(parseMacTextImages('p20\0\nftxt\0n/unbound\0\n').get(20)).toEqual([]);
    expect(() => parseMacTextImages('p20\0\nftxt\0Dnot-a-device\0')).toThrow();
  });
  it.skipIf(isWindows())('keeps readable macOS argv and image without requiring lsof or a positive exit proof', async () => {
    const node = realpathSync(process.execPath), records = [record(process.pid, node), { ...record(1234567), argv: null, executable: null }];
    const dataset = await readMacProcessTables(async () => { throw Error('no lsof required'); }, () => structuredClone(records));
    expect(dataset.before).toEqual(records);
    expect(assessGlobalProcesses(scope, dataset)).toMatchObject({ status: 'ready', counts: { unreadable: 1 } });
  });
  it.skipIf(!isWindows())('executes the exact Windows probe with a scoped fake CIM cmdlet and validates its phase protocol', async () => {
    const command = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const node = process.execPath.replaceAll("'", "''");
    const script = String.raw`$script:fixtureCalls=0
function Get-CimInstance {
  param($ClassName,$Property,$ErrorAction)
  if($ClassName -ne 'Win32_Process'){throw 'unexpected_class'}
  $script:fixtureCalls++
  $probe=[Diagnostics.Process]::GetCurrentProcess()
  [pscustomobject]@{ProcessId=$PID;ParentProcessId=@@PARENT@@;CreationDate=$probe.StartTime.ToUniversalTime();ExecutablePath=$probe.MainModule.FileName;CommandLine='fixture-owned-probe'}
  [pscustomobject]@{ProcessId=@@PARENT@@;ParentProcessId=1;CreationDate=[DateTime]::Parse('2026-01-01T00:00:00Z');ExecutablePath='@@NODE@@';CommandLine='fixture-parent'}
}
` .replaceAll('@@PARENT@@', String(process.pid)).replaceAll('@@NODE@@', node) + WINDOWS_PROCESS_PROBE + '\nif($script:fixtureCalls -ne 2){exit 91}';
    const events: ProcessProbeEvent[] = [];
    const result = await ownedProcessProbe(event => events.push(event))(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], 'cim', Date.now() + 20000);
    expect(decodeWindowsProcessTables(result.stdout, result.pid).before).toHaveLength(2);
    expect(events.filter(row => row.phase === 'cim:before').map(row => row.event)).toEqual(['started', 'completed']);
    expect(events.filter(row => row.phase === 'cim:after').map(row => row.event)).toEqual(['started', 'completed']);
  });
});
