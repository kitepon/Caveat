import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { nativeSyncSchedule, quoteWindowsArgument, type NativeSyncScheduleOptions, type ScheduleCommand } from '../src/platform.js';
import { manageSyncSchedule, type ScheduleRunner } from '../src/syncSchedule.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
function fixture(platform: NodeJS.Platform) {
  const root = mkdtempSync(join(tmpdir(), 'caveat-schedule-')); roots.push(root);
  const opts: NativeSyncScheduleOptions = { caveatHome: join(root, '私 & data'), userHome: join(root, 'user space'), nodePath: process.execPath, cliPath: join(root, 'CLI space', 'caveat.js'), platform, uid: 501, userId: 'EXAMPLE\\fixture' };
  const plan = nativeSyncSchedule(opts);
  let present = false; let fail = false; let readbackWrong = false;
  const calls: ScheduleCommand[] = [];
  const run: ScheduleRunner = command => {
    calls.push(command);
    const args = command.args;
    if (command.command === 'powershell.exe' && !args.includes('-EncodedCommand')) return { status: present ? 0 : 3, stdout: '' };
    if (args.includes('show')) return { status: 0, stdout: present ? 'loaded' : 'not-found' };
    if (args.includes('print') || args.includes('/Query') || args.includes('-EncodedCommand') || args.includes('is-active')) {
      if (!present) return { status: plan.kind === 'launchd-user' ? 113 : 1, stdout: '' };
      return { status: 0, stdout: plan.kind === 'windows-task' ? (readbackWrong ? plan.files[0]!.content.replace('caveat.js', 'foreign.js') : (existsSync(plan.files[0]!.path) ? readFileSync(plan.files[0]!.path, 'utf8') : plan.files[0]!.content)) : 'active' };
    }
    if (args.includes('enable') || args.includes('bootstrap') || args.includes('/Create')) {
      if (fail) return { status: 1, stdout: 'private native error must not leak' };
      present = true;
    }
    if (args.includes('disable') || args.includes('bootout') || args.includes('/Delete')) present = false;
    return { status: 0, stdout: '' };
  };
  return { opts: { ...opts, runner: run }, plan, calls, root, present: () => present,
    setPresent: () => { present = true; }, setFail: (value: boolean) => { fail = value; }, setWrong: () => { readbackWrong = true; } };
}

for (const platform of ['linux', 'darwin', 'win32'] as const) describe(`${platform} native schedule isolated contract`, () => {
  it('dry-run emits fixed home/Node/CLI argv without file writes or commands', () => {
    const f = fixture(platform);
    const result = manageSyncSchedule('install', { ...f.opts, dryRun: true });
    expect(result.status).toBe('planned'); expect(f.calls).toEqual([]);
    expect(existsSync(f.opts.caveatHome)).toBe(false); expect(existsSync(f.opts.userHome)).toBe(false);
    expect(result.definition!.argv).toEqual([process.execPath, f.opts.cliPath, 'autosync', 'run', '--json', '--caveat-home', f.opts.caveatHome, '--user-home', f.opts.userHome]);
  });
  it('installs, reads back, repeats without native changes, updates and removes only owned files', () => {
    const f = fixture(platform);
    expect(manageSyncSchedule('install', f.opts)).toMatchObject({ status: 'success', registered: true, definition_matches: true });
    const firstCalls = f.calls.length;
    expect(manageSyncSchedule('install', f.opts).reason).toBe('unchanged');
    expect(f.calls.slice(firstCalls).every(c => c.command === 'powershell.exe' || c.args.includes('show') || c.args.includes('print') || c.args.includes('/Query') || c.args.includes('is-active'))).toBe(true);
    expect(manageSyncSchedule('status', f.opts).status).toBe('success');
    const updated = { ...f.opts, cliPath: join(f.root, 'updated', 'caveat.js') };
    expect(manageSyncSchedule('install', updated).status).toBe('success');
    expect(manageSyncSchedule('uninstall', updated).status).toBe('uninstalled'); expect(f.present()).toBe(false);
    for (const file of f.plan.files) expect(existsSync(file.path)).toBe(false);
    expect(manageSyncSchedule('uninstall', updated).status).toBe('uninstalled');
  });
  it('refuses existing foreign files and foreign native jobs', () => {
    const f = fixture(platform); const file = f.plan.files[0]!;
    mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.path, 'foreign');
    expect(manageSyncSchedule('install', f.opts).reason).toBe('schedule_file_unmanaged'); expect(f.calls).toEqual([]);
    expect(readFileSync(file.path, 'utf8')).toBe('foreign');
    rmSync(file.path); f.setPresent();
    expect(manageSyncSchedule('install', f.opts).reason).toBe('schedule_job_unmanaged');
    expect(f.present()).toBe(true); expect(existsSync(file.path)).toBe(false);
  });
  it('retains registration failure across later success and protects modified definitions', () => {
    const f = fixture(platform); f.setFail(true);
    expect(manageSyncSchedule('install', f.opts).reason).toBe('schedule_native_command_failed');
    const manifest = join(f.opts.caveatHome, 'sync', '.schedule.json');
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ registered: false, last_failure: 'schedule_native_command_failed' });
    f.setFail(false); expect(manageSyncSchedule('install', f.opts).status).toBe('success');
    expect(JSON.parse(readFileSync(manifest, 'utf8')).last_failure).toBe('schedule_native_command_failed');
    const before = readFileSync(manifest, 'utf8'); writeFileSync(f.plan.files[0]!.path, 'modified');
    expect(manageSyncSchedule('uninstall', f.opts).reason).toBe('schedule_definition_changed');
    expect(readFileSync(manifest, 'utf8')).toBe(before); expect(f.present()).toBe(true);
  });
  it('live cycle lock blocks removal without changing stored results', () => {
    const f = fixture(platform); expect(manageSyncSchedule('install', f.opts).status).toBe('success');
    const manifest = join(f.opts.caveatHome, 'sync', '.schedule.json'); const before = readFileSync(manifest, 'utf8');
    writeFileSync(join(f.opts.caveatHome, 'sync', '.periodic-sync-lock'), String(process.pid));
    const calls = f.calls.length;
    expect(manageSyncSchedule('uninstall', f.opts).reason).toBe('schedule_cycle_busy');
    expect(readFileSync(manifest, 'utf8')).toBe(before); expect(f.calls.length).toBe(calls); expect(f.present()).toBe(true);
  });
  it('missing native registration is a failed readback and status stays read-only', () => {
    const f = fixture(platform); expect(manageSyncSchedule('install', f.opts).status).toBe('success');
    const manifest = join(f.opts.caveatHome, 'sync', '.schedule.json'); const before = readFileSync(manifest, 'utf8');
    const run: ScheduleRunner = () => ({ status: 1, stdout: '' });
    expect(manageSyncSchedule('status', { ...f.opts, runner: run })).toMatchObject({ status: 'failed', registered: false, reason: 'schedule_readback_failed' });
    expect(readFileSync(manifest, 'utf8')).toBe(before);
  });
});

it('quotes XML, Windows arguments, and systemd expansions without a shell', () => {
  expect(quoteWindowsArgument('a"b\\')).toBe('"a\\"b\\\\"');
  const f = fixture('linux');
  const opts = { ...f.opts, cliPath: join(f.root, '私 & " % $x', 'caveat.js') };
  expect(nativeSyncSchedule(opts).files[0]!.content).toContain('%% $$x');
  const mac = nativeSyncSchedule({ ...opts, platform: 'darwin' });
  const parsed = new XMLParser().parse(mac.files[0]!.content);
  expect(parsed.plist.dict.array.string).toEqual(mac.argv);
  const windows = nativeSyncSchedule({ ...opts, platform: 'win32' });
  const task = new XMLParser().parse(windows.files[0]!.content).Task;
  expect(task.Actions.Exec.Command).toBe(opts.nodePath); expect(task.Principals.Principal.UserId).toBe(opts.userId);
  expect(task.Actions.Exec.Arguments).toContain(quoteWindowsArgument(opts.cliPath));
});
it('rejects relative/control-character paths and distinct homes have distinct identities', () => {
  const f = fixture('linux');
  expect(() => nativeSyncSchedule({ ...f.opts, cliPath: 'relative.js' })).toThrow('schedule_absolute_path_required');
  expect(() => nativeSyncSchedule({ ...f.opts, cliPath: '/newline\n' })).toThrow('schedule_absolute_path_required');
  expect(nativeSyncSchedule({ ...f.opts, caveatHome: join(f.root, 'other') }).id).not.toBe(f.plan.id);
});
it('Windows readback refuses a registered task with different executable arguments', () => {
  const f = fixture('win32'); f.setWrong();
  expect(manageSyncSchedule('install', f.opts)).toMatchObject({ status: 'failed', reason: 'schedule_readback_failed' });
  expect(f.present()).toBe(true); // Keep the failure and do not delete a possibly live task.
});

it('Windows refuses removal or update after a native task is changed outside Caveat', () => {
  const f = fixture('win32'); expect(manageSyncSchedule('install', f.opts).status).toBe('success');
  const manifest = join(f.opts.caveatHome, 'sync', '.schedule.json'); const before = readFileSync(manifest, 'utf8');
  f.setWrong();
  expect(manageSyncSchedule('uninstall', f.opts).reason).toBe('schedule_native_changed');
  expect(f.present()).toBe(true); expect(readFileSync(manifest, 'utf8')).toBe(before);
});

it('uninstall reload failure retains a retryable removed definition and failure outcome', () => {
  const f = fixture('linux'); expect(manageSyncSchedule('install', f.opts).status).toBe('success');
  const runner: ScheduleRunner = command => command.args.includes('daemon-reload') ? { status: 1, stdout: '' } : f.opts.runner(command);
  expect(manageSyncSchedule('uninstall', { ...f.opts, runner }).reason).toBe('schedule_native_command_failed');
  const manifest = join(f.opts.caveatHome, 'sync', '.schedule.json');
  expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ registered: false, file_hashes: {}, last_failure: 'schedule_native_command_failed' });
  expect(manageSyncSchedule('uninstall', f.opts).status).toBe('uninstalled');
  expect(JSON.parse(readFileSync(manifest, 'utf8')).last_failure).toBe('schedule_native_command_failed');
});
it('stored native query commands never execute from the ownership manifest', () => {
  const f = fixture('win32'); expect(manageSyncSchedule('install', f.opts).status).toBe('success');
  const manifest = join(f.opts.caveatHome, 'sync', '.schedule.json'); const stored = JSON.parse(readFileSync(manifest, 'utf8'));
  stored.definition.query = { command: 'must-not-execute', args: [] }; writeFileSync(manifest, JSON.stringify(stored));
  expect(manageSyncSchedule('uninstall', f.opts).status).toBe('uninstalled');
  expect(f.calls.some(call => call.command === 'must-not-execute')).toBe(false);
});

it('Windows inspection errors retain live tasks and definition files', () => {
  const f = fixture('win32'); expect(manageSyncSchedule('install', f.opts).status).toBe('success');
  const runner: ScheduleRunner = command => command.command === 'powershell.exe' ? { status: 1, stdout: 'access denied' } : f.opts.runner(command);
  expect(manageSyncSchedule('uninstall', { ...f.opts, runner }).reason).toBe('schedule_inspection_failed');
  expect(f.present()).toBe(true); expect(existsSync(f.plan.files[0]!.path)).toBe(true);
});

it('Linux links definitions outside the manager home and disables both owned links', () => {
  const f = fixture('linux');
  expect(f.plan.install[0]).toEqual({ command: 'systemctl', args: ['--user', 'link', ...f.plan.files.map(file => file.path)] });
  expect(f.plan.remove[0]!.args).toEqual(['--user', 'stop', `${f.plan.id}.timer`, `${f.plan.id}.service`]);
  expect(f.plan.remove[1]!.args).toEqual(['--user', 'disable', `${f.plan.id}.timer`, `${f.plan.id}.service`]);
});

it('Linux retains ownership after link succeeds and enable fails, allowing retry or uninstall', () => {
  for (const recovery of ['install', 'uninstall'] as const) {
    const f = fixture('linux'); let loaded = false; let enabled = false; let fail = true;
    const runner: ScheduleRunner = command => {
      if (command.args.includes('link')) loaded = true;
      if (command.args.includes('show')) return { status: 0, stdout: loaded ? 'loaded' : 'not-found' };
      if (command.args.includes('is-active')) return { status: enabled ? 0 : 3, stdout: enabled ? 'active' : 'inactive' };
      if (command.args.includes('enable')) { if (fail) return { status: 1, stdout: '' }; enabled = true; }
      if (command.args.includes('disable')) { loaded = false; enabled = false; }
      return { status: 0, stdout: '' };
    };
    const opts = { ...f.opts, runner };
    expect(manageSyncSchedule('install', opts).reason).toBe('schedule_native_command_failed');
    expect(loaded).toBe(true); fail = false;
    expect(manageSyncSchedule(recovery, opts).status).toBe(recovery === 'install' ? 'success' : 'uninstalled');
    if (recovery === 'install') expect(manageSyncSchedule('uninstall', opts).status).toBe('uninstalled');
    expect(loaded).toBe(false);
  }
});

it('Linux stops linked units before disable removes their manager definitions', () => {
  const f = fixture('linux'); let loaded = false; let active = false;
  const runner: ScheduleRunner = command => {
    const args = command.args;
    if (args.includes('show')) return { status: 0, stdout: loaded ? 'loaded' : 'not-found' };
    if (args.includes('is-active')) return { status: active ? 0 : 3, stdout: active ? 'active' : 'inactive' };
    if (args.includes('link')) loaded = true;
    if (args.includes('enable')) active = true;
    if (args.includes('stop')) { if (!loaded) return { status: 5, stdout: '' }; active = false; }
    if (args.includes('disable')) {
      loaded = false;
      // systemctl disable --now resolves stop after unlink/reload: no unit.
      if (args.includes('--now')) return { status: 5, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };
  expect(manageSyncSchedule('install', { ...f.opts, runner }).status).toBe('success');
  expect(manageSyncSchedule('uninstall', { ...f.opts, runner }).status).toBe('uninstalled');
  expect(active).toBe(false); expect(loaded).toBe(false);
  expect(f.plan.files.every(file => !existsSync(file.path))).toBe(true);
});

it('Windows reads non-ASCII XML through a read-only explicit UTF-8 COM command', () => {
  const f = fixture('win32');
  expect(f.plan.query.command).toBe('powershell.exe');
  const script = Buffer.from(f.plan.query.args.at(-1)!, 'base64').toString('utf16le');
  expect(script).toContain('(New-Object System.Text.UTF8Encoding($false)).GetBytes($task.Xml)');
  expect(script).toContain('[Console]::OpenStandardOutput()');
  expect(script).toContain('$stdout.Write($bytes, 0, $bytes.Length)');
  expect(script).toContain(`GetTask('${f.plan.id}')`);
  expect(script).not.toMatch(/RegisterTask|DeleteTask|CreateTask|Set-ScheduledTask/);
});
it('Windows recovers an owned task after a corrupt-encoding readback and retains the failure', () => {
  const f = fixture('win32');
  const damaged: ScheduleRunner = command => {
    const result = f.opts.runner(command);
    return command.args.includes('-EncodedCommand') ? { ...result, stdout: result.stdout.replace(/[^\x00-\x7f]/g, '?') } : result;
  };
  expect(manageSyncSchedule('install', { ...f.opts, runner: damaged }).reason).toBe('schedule_readback_failed');
  expect(f.present()).toBe(true);
  const manifest = join(f.opts.caveatHome, 'sync', '.schedule.json');
  expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ registered: false, last_failure: 'schedule_readback_failed' });
  expect(manageSyncSchedule('install', f.opts).status).toBe('success');
  expect(JSON.parse(readFileSync(manifest, 'utf8')).last_failure).toBe('schedule_readback_failed');
  expect(manageSyncSchedule('uninstall', f.opts).status).toBe('uninstalled');
  expect(f.present()).toBe(false);
});

it('Windows imports UTF-8 files through a Unicode string without a conflicting declaration', () => {
  const f = fixture('win32');
  const importThroughBstr: ScheduleRunner = command => {
    if (command.args.includes('/Create')) {
      const payload = readFileSync(f.plan.files[0]!.path, 'utf8');
      expect(payload).not.toMatch(/encoding\s*=/i);
      // TaskDefinition.XmlText on Windows rejects a UTF-8 declaration in BSTR.
      if (/<\?xml[^?]*encoding=["']UTF-8["']/i.test(payload)) return { status: 1, stdout: 'unable to switch the encoding' };
      const document = new XMLParser().parse(payload).Task;
      expect(document.Actions.Exec.Command).toBe(f.opts.nodePath);
      expect(document.Actions.Exec.Arguments).toContain('私 & data');
      expect(document.Principals.Principal.LogonType).toBe('InteractiveToken');
    }
    return f.opts.runner(command);
  };
  expect(manageSyncSchedule('install', { ...f.opts, runner: importThroughBstr }).status).toBe('success');
  expect(manageSyncSchedule('status', f.opts).status).toBe('success');
  expect(manageSyncSchedule('uninstall', f.opts).status).toBe('uninstalled');
});
