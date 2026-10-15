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
    if (command.command === 'powershell.exe') return { status: present ? 0 : 3, stdout: '' };
    if (args.includes('show')) return { status: 0, stdout: present ? 'loaded' : 'not-found' };
    if (args.includes('print') || args.includes('/Query') || args.includes('is-active')) {
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
