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
  it('assesses a configuration-only scope without inventing a package root or excluding its own executable', () => {
    const scope = { binAliases: [], protectedPaths: ['/profile/.claude.json'], runtimeExecutables: ['/runtime/node'] };
    expect(assessGlobalProcesses(scope, tables(record(20)))).toMatchObject({ status: 'ready', consumers: 0 });
    expect(assessGlobalProcesses(scope, tables(record(20, '/usr/bin/editor', ['editor', '/profile/.claude.json'])))).toMatchObject({ status: 'stopped', unknown: 1 });
  });
  it('binds the current kernel executable and classifies stable outside-scope native processes', () => {
    const result = assessGlobalProcesses(scope, tables(record(20)));
    expect(result.status).toBe('ready');
    expect(result.records.map(row => row.classification)).toEqual(['self', 'outside-observed-scope']);
    expect(result.filesystemWrites).toBe(0); expect(result.existingProcessOperations).toBe(0);
  });
  it('rejects an invalid scope before collecting any native process data', async () => {
    let called = false;
    await expect(preflightGlobalProcesses({ ...scope, packageRoot: '/global/../elsewhere' }, () => {}, async () => { called = true; return tables(); })).rejects.toThrow('absolute_process_scope_required');
    expect(called).toBe(false);
  });
  it.each([scope.packageRoot + '/dist/caveat.js', scope.binAliases[0]!])('blocks an old package or bound bin argument: %s', script => {
    const result = assessGlobalProcesses(scope, tables(record(20, '/runtime/node', ['node', script, 'mcp-server'])));
    expect(result.status).toBe('stopped'); expect(result.consumers).toBe(1);
  });
  it('blocks npm independently of the old package argument', () => {
    const result = assessGlobalProcesses(scope, tables(record(20, '/runtime/node', ['node', '/runtime/npm/bin/npm-cli.js', 'install'])));
    expect(result.writers).toBe(1); expect(result.status).toBe('stopped');
  });
  it('recognizes the selected runtime under an arbitrary executable name', () => {
    const selected = '/ordinary/custom-runtime';
    expect(assessGlobalProcesses(scope, tables(record(20, selected, [selected, '/unrelated/script.js']))).status).toBe('ready');
    const result = assessGlobalProcesses({ ...scope, runtimeExecutables: [selected] }, tables(record(20, selected, [selected, '/unrelated/script.js'])));
    expect(result.status).toBe('ready'); expect(result.unknown).toBe(0);
  });
  it('requires a bound Node script slot and leaves data/flag literals unknown', () => {
    const root = scope.packageRoot + '/dist/caveat.js';
    const script = record(20, '/runtime/node', ['node', '--disable-warning=ExperimentalWarning', root, 'mcp-server']);
    expect(assessGlobalProcesses(scope, tables(script)).consumers).toBe(1);
    for (const row of [record(20, '/native/tool', ['/native/tool', '--data=' + root]), record(20, '/runtime/node', ['node', '--unknown-flag', root])]) {
      const result = assessGlobalProcesses(scope, tables(row)); expect(result.consumers).toBe(0); expect(result.unknown).toBe(1);
    }
    const own = tables(); own.before[0]!.argv = ['node', root]; own.after[0]!.argv = ['node', root];
    expect(assessGlobalProcesses(scope, own).status).toBe('stopped');
  });
  it('classifies readable unrelated runtimes and inline commands within the explicit observation contract', () => {
    for (const row of [record(20, '/runtime/node', ['node', '/elsewhere/program.js']), record(21, '/usr/bin/python3'), record(22, '/bin/sh', ['sh', '-c', 'hidden-command']), record(23, '/system/cmd.exe', ['cmd.exe', '/c', 'npm install'])]) {
      const result = assessGlobalProcesses(scope, tables(row));
      expect(result.status).toBe('ready'); expect(result.counts['outside-observed-scope']).toBe(1);
      expect(result.residualRisks.join(' ')).toContain('dynamic import');
    }
  });
  it('does not mistake a neighbouring package path for the old package', () => {
    const result = assessGlobalProcesses(scope, tables(record(20, '/native/tool', ['/native/tool', scope.packageRoot + '-other/file'])));
    expect(result.consumers).toBe(0);
  });
  it('keeps permission-denied process metadata unknown rather than using a process name', () => {
    const row = { ...record(20), executable: null, argv: null, reason: 'EACCES' };
    const result = assessGlobalProcesses(scope, tables(row));
    expect(result.status).toBe('stopped'); expect(result.unknown).toBe(1);
  });
  it.each(['birth', 'executable'] as const)('stops on changed process %s', field => {
    const value = tables(record(20));
    const last = value.after[1]!;
    if (field === 'birth') last.birth = 'different-birth';
    else if (field === 'executable') last.executable = { path: '/new/image', dev: '1', ino: '99' };

    expect(assessGlobalProcesses(scope, value).unknown).toBe(1);
  });
  it('requires the current self identity and classifies readable transients outside observed scope', () => {
    const value = tables(record(20)); value.after.pop();
    expect(assessGlobalProcesses(scope, value)).toMatchObject({ status: 'ready', counts: { transient: 1 } });
    value.before = value.before.filter(row => row.pid !== 10); value.after = [];
    expect(assessGlobalProcesses(scope, value).errors).toContain('current_process_not_bound');
  });
  it('accepts only the same stable kernel zombie birth as non-executing', () => {
    const value = tables({ ...record(20), state: 'Z', executable: null, argv: null });
    expect(assessGlobalProcesses(scope, value).records[1]?.classification).toBe('non-executing');
    value.after[1]!.birth = 'new-birth';
    expect(assessGlobalProcesses(scope, value).status).toBe('stopped');
  });
  it('classifies kernel threads, readable foreign users and a bound finite ancestor chain', () => {
    const value = tables({ ...record(1, '/bin/bash'), ppid: 0 },
      { ...record(20), uid: 2000, executable: null },
      { ...record(30), kernel: 'linux-pf-kthread', executable: null, argv: null });
    expect(assessGlobalProcesses(scope, value)).toMatchObject({ status: 'ready', counts: { ancestor: 1, 'foreign-user': 1, 'non-executing': 1 } });
    value.after[1]!.birth = 'changed';
    expect(assessGlobalProcesses(scope, value).status).toBe('stopped');
  });
  it('checks literals in both observations before foreign, ancestor, transient, zombie or inline classification', () => {
    for (const data of [
      { ...record(20), uid: 2000, executable: null },
      { ...record(1, '/bin/bash'), ppid: 0 },
      record(21, '/usr/bin/python3'),
    ]) {
      data.argv = [data.executable?.path ?? 'foreign', '-e', 'require("' + scope.packageRoot + '")'];
      for (const transient of [false, true]) {
        const value = tables(data); if (transient) value.after.pop();
        expect(assessGlobalProcesses(scope, value).status).toBe('stopped');
      }
    }
  });
  it('records deleted runtime images and applies the same literal and bound-script rules', () => {
    const row = record(20, '/usr/bin/node (deleted)', ['node', '/outside/program.js']);
    expect(assessGlobalProcesses(scope, tables(row))).toMatchObject({ status: 'ready', records: [{}, { imageDeleted: true, runtime: true }] });
    row.argv![1] = scope.packageRoot + '/index.js';
    expect(assessGlobalProcesses(scope, tables(row))).toMatchObject({ status: 'stopped', consumers: 1 });
  });
  it('requires readable foreign argv and rejects ancestor cycles and incomplete same-uid transients', () => {
    const value = tables({ ...record(20), uid: 2000, argv: null });
    expect(assessGlobalProcesses(scope, value).unknown).toBe(1);
    value.before[1]!.uid = 1000; value.after.pop();
    expect(assessGlobalProcesses(scope, value).unknown).toBe(1);
    const cycle = tables({ ...record(1), ppid: 10 });
    expect(assessGlobalProcesses(scope, cycle).errors).toContain('process_ancestor_cycle_or_bound');
  });
  it('allows a read-only nvm runtime sibling while still stopping old-global literals under the same prefix', () => {
    const prefix = '/home/user/.nvm/versions/node/v24.14.1', node = prefix + '/bin/node';
    const affected = { packageRoot: prefix + '/lib/node_modules/caveat-cli', npmRoot: prefix + '/lib/node_modules/npm',
      runtimeExecutables: [node], binAliases: [prefix + '/bin/caveat'], protectedPaths: ['/managed/entry/caveat.mjs'] };
    expect(assessGlobalProcesses(affected, tables(record(20, node, [node, '/app/bellteam.js']))).status).toBe('ready');
    for (const argv of [[node, affected.packageRoot + '/dist/caveat.js'], [node, '-e', 'require("' + affected.packageRoot + '")']]) {
      expect(assessGlobalProcesses(affected, tables(record(20, node, argv))).status).toBe('stopped');
    }
  });
  it('admits only the exact Darwin foreign-owner argv denial, including readable/unreadable observation transitions', () => {
    const foreign: NativeProcessRecord = { ...record(20), uid: 2000, ownerProof: 'darwin-kinfo-proc', argv: null,
      argumentFailure: { stage: 'read', nativeCode: 22, sizeQuerySucceeded: true }, imageBinding: 'kernel-path' };
    const data = tables(foreign);
    expect(assessGlobalProcesses(scope, data)).toMatchObject({ status: 'ready', counts: { 'foreign-user-unobservable': 1 } });
    data.before[1]!.argv = ['/usr/bin/native-tool']; delete data.before[1]!.argumentFailure;
    data.before[1]!.imageBinding = 'kernel-and-text';
    expect(assessGlobalProcesses(scope, data).status).toBe('ready');
    data.before[1]!.argv = ['/usr/bin/native-tool', scope.packageRoot];
    expect(assessGlobalProcesses(scope, data).status).toBe('stopped');
  });
  it.each(['same-owner', 'unknown-owner', 'root-caller', 'missing-kinfo', 'size-failed', 'wrong-errno', 'unknown-image', 'changed-image', 'changed-birth', 'node', 'protected-runtime'])(
    'refuses an unobservable process without the complete Darwin exception: %s', kind => {
      const foreign: NativeProcessRecord = { ...record(20), uid: 2000, ownerProof: 'darwin-kinfo-proc', argv: null,
        argumentFailure: { stage: 'read', nativeCode: 22, sizeQuerySucceeded: true }, imageBinding: 'kernel-path' };
      let affected = scope;
      if (kind === 'same-owner') foreign.uid = 1000;
      if (kind === 'unknown-owner') foreign.uid = null;
      if (kind === 'missing-kinfo') delete foreign.ownerProof;
      if (kind === 'size-failed') foreign.argumentFailure!.sizeQuerySucceeded = false;
      if (kind === 'wrong-errno') foreign.argumentFailure!.nativeCode = 13;
      if (kind === 'unknown-image') foreign.executable = null;
      if (kind === 'node') foreign.executable!.path = '/usr/bin/node';
      if (kind === 'protected-runtime') affected = { ...scope, runtimeExecutables: [foreign.executable!.path] };
      const data = tables(foreign);
      if (kind === 'root-caller') { data.before[0]!.uid = 0; data.after[0]!.uid = 0; }
      if (kind === 'changed-birth') data.after[1]!.birth = 'changed';
      if (kind === 'changed-image') data.after[1]!.executable!.ino = '77777';
      expect(assessGlobalProcesses(affected, data).status).toBe('stopped');
    });
  it('retains a typed metadata refusal from the second observation without exposing argv', () => {
    const data = tables(record(20, '/runtime/node', ['node', 'private-argument']));
    data.after[1]!.executable = null;
    data.after[1]!.windowsFields = { executable: 'null', arguments: 'present' };
    const result = assessGlobalProcesses(scope, data), row = result.records.find(row => row.pid === 20)!;
    expect(row.reason).toBe('process_executable_observation_incomplete');
    expect(row.observation?.nativeIssues).toContain('windows-metadata:executable-null:null');
    expect(JSON.stringify(result)).not.toContain('private-argument');
  });
  it('does not retain arbitrary arguments or executable paths in public projections', () => {
    const result = assessGlobalProcesses(scope, tables(record(20, '/runtime/node', ['node', 'secret-argument-value'])));
    expect(JSON.stringify(result)).not.toContain('secret-argument-value');
    expect(JSON.stringify(result)).not.toContain('/runtime/node');
  });
  it('keeps an unsuccessful collection and unobserved helper closure unknown without exporting native error text', async () => {
    const result = await preflightGlobalProcesses(scope, () => {}, async () => { throw Error('native-error-with-secret-value'); });
    expect(result.status).toBe('stopped'); expect(result.unknown).toBeNull(); expect(result.consumers).toBeNull(); expect(result.writers).toBeNull();
    expect('ownedProbe' in result && result.ownedProbe).toBeNull();
    expect(JSON.stringify(result)).not.toContain('native-error-with-secret-value');
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
    expect(missing.status).toBe('stopped'); expect(missing.unknown).toBe(1);
  });
  it.skipIf(isWindows())('drops an ENOENT row only after an independent kernel exit proof, retaining inaccessible live metadata', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-exited-procfs-'))); roots.push(root);
    const live = join(root, String(process.pid)), gonePid = process.pid + 1000000;
    mkdirSync(live); mkdirSync(join(root, String(gonePid)));
    const fields = ['S', '1', ...Array(17).fill('0'), '987654', ...Array(30).fill('0')];
    writeFileSync(join(live, 'stat'), process.pid + ' (fixture) ' + fields.join(' '));
    writeFileSync(join(live, 'status'), 'Uid: 1000 1000 1000 1000\n');
    symlinkSync(process.execPath, join(live, 'exe')); writeFileSync(join(live, 'cmdline'), process.execPath + '\0fixture\0');
    expect(assessGlobalProcesses(scope, readLinuxProcessTables(root)).status).toBe('stopped');
    const exited = readLinuxProcessTables(root, pid => pid === gonePid);
    expect(exited.confirmedExitedDuringRead).toBe(2); expect(assessGlobalProcesses(scope, exited).status).toBe('ready');
    rmSync(join(live, 'cmdline'));
    expect(assessGlobalProcesses(scope, readLinuxProcessTables(root, pid => pid === gonePid)).status).toBe('stopped');
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
  it.skipIf(isWindows())('binds macOS kernel process paths only after text image and POSIX file identities match', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-process-mac-'))); roots.push(root);
    const image = join(root, 'native binary'); writeFileSync(image, 'fixture');
    const fakePid = process.pid + 1000000, node = realpathSync(process.execPath);
    const records = [record(process.pid, node), record(fakePid, image)].map(row => {
      const stat = statSync(row.executable!.path, { bigint: true });
      return { ...row, executable: { path: row.executable!.path, dev: String(stat.dev), ino: String(stat.ino) } };
    });
    const images = [[process.pid, node], [fakePid, image]].map(([pid, path]) => {
      const stat = statSync(String(path), { bigint: true });
      return `p${pid}\0\nftxt\0D0x${stat.dev.toString(16)}\0i${stat.ino}\0n${path}\0\n`;
    }).join('');
    const run = async () => ({ stdout: images, pid: fakePid + 1 });
    const dataset = await readMacProcessTables(run, () => structuredClone(records));
    expect(dataset.before[1]?.executable?.path).toBe(image);
    const result = assessGlobalProcesses(scope, dataset);
    expect(result.status).toBe('ready');
    const unbound = await readMacProcessTables(async () => ({ stdout: '', pid: fakePid + 1 }), () => structuredClone(records));
    expect(assessGlobalProcesses(scope, unbound).status).toBe('stopped');
    expect(unbound.before[1]?.executable).toBeNull();
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


it('keeps native commands naming protected Node, entry or settings paths unknown', () => {
  for (const file of ['/runtime/ordinary-node', '/managed/entry/caveat.mjs', '/profile/client/settings.json']) {
    const result = assessGlobalProcesses({ ...scope, protectedPaths: [file] }, tables(record(20, '/usr/bin/cp', ['cp', '/input', file])));
    expect(result.status).toBe('stopped'); expect(result.unknown).toBe(1); expect(result.records[1]!.reason).toBe('scope_literal_outside_bound_script');
  }
});
