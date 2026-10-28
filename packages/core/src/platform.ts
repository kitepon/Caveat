import type { Stats } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import { join, isAbsolute, win32 } from 'node:path';

/**
 * OS 依存の判定はこのモジュールに集約する。他のファイルで
 * `process.platform` / `win32` を直接分岐しない(データとして記録する
 * fingerprint 等は除く)。全関数は platform を引数で受けてテスト可能にする。
 */

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export function globalNpmLayout(globalRoot: string, platform: NodeJS.Platform = process.platform) {
  const npmPaths = platform === 'win32' ? win32 : win32.posix;
  if (npmPaths.basename(globalRoot) !== 'node_modules') throw Error('global_npm_layout_invalid');
  if (platform === 'win32') return { prefix: npmPaths.dirname(globalRoot), binDirectory: npmPaths.dirname(globalRoot) };
  if (platform === 'linux' || platform === 'darwin') {
    if (npmPaths.basename(npmPaths.dirname(globalRoot)) !== 'lib') throw Error('global_npm_layout_invalid');
    const prefix = npmPaths.dirname(npmPaths.dirname(globalRoot)); return { prefix, binDirectory: join(prefix, 'bin') };
  }
  throw Error('global_npm_platform_unsupported');
}

/** The owned npm child inherits no Node options, npm configuration or credentials. */
export function globalNpmEnvironment(node: string, run: string, platform: NodeJS.Platform = process.platform) {
  const npmPaths = platform === 'win32' ? win32 : win32.posix;
  const env: NodeJS.ProcessEnv = { PATH: npmPaths.dirname(node), HOME: run, TMPDIR: run, TMP: run, TEMP: run, LC_ALL: 'C', LANG: 'C', CI: '1', NO_COLOR: '1' };
  if (platform === 'win32') {
    if (!process.env.SystemRoot || !win32.isAbsolute(process.env.SystemRoot)) throw Error('global_npm_system_root_required');
    env.SystemRoot = process.env.SystemRoot; env.USERPROFILE = run; env.APPDATA = run; env.LOCALAPPDATA = run;
  }
  return env;
}

/** Native constants absent from Node's fs.constants; never infer them from another OS. */
export function globalFilesystemNativeSpec(platform: NodeJS.Platform = process.platform, architecture: string = process.arch) {
  if (platform === 'linux') return { windows: false as const, library: null,
    closeOnExec: 0x80000, linkOpen: 0x220000, loopError: 40, rename: 'renameat2', noReplace: 1, directoryRead: 'readdir', directoryNameOffset: 19,
    xattrListTail: [] as number[], xattrGetTail: [] as number[], linkAttributesViaProc: true, fullSync: undefined as number | undefined, aclType: undefined as number | undefined };
  if (platform === 'darwin') return { windows: false as const, library: '/usr/lib/libSystem.B.dylib',
    closeOnExec: 0x1000000, linkOpen: 0x200000, loopError: 62, rename: 'renameatx_np', noReplace: 4, directoryRead: architecture === 'x64' ? 'readdir$INODE64' : 'readdir', directoryNameOffset: 21,
    xattrListTail: [0x20], xattrGetTail: [0, 0x20], linkAttributesViaProc: false, fullSync: 51, aclType: 0x100 };
  if (platform === 'win32') return { windows: true as const };
  throw Error('global_filesystem_platform_not_implemented');
}

export function collectNativeGlobalProcesses<T>(readers: { linux: () => T; darwin: () => T; win32: (command: string) => T }, platform: NodeJS.Platform = process.platform): T {
  if (platform === 'linux') return readers.linux();
  if (platform === 'darwin') return readers.darwin();
  if (platform === 'win32') {
    const root = process.env.SystemRoot;
    if (!root || !win32.isAbsolute(root) || /[\x00-\x1f]/.test(root)) throw Error('process_system_root_unavailable');
    return readers.win32(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  throw Error('global_process_platform_not_implemented');
}

/**
 * env を考慮した Windows 判定。`OS=Windows_NT` は Windows native shell が必ず持つ
 * 環境変数で、テストが env 注入だけで Windows 経路を選べるようにする
 * (runtimeErrors が独自に持っていた判定をここへ集約。v0.17.5)。
 */
export function isWindowsEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return env.OS === 'Windows_NT' || isWindows(platform);
}

/**
 * owner-only 所有チェック。Node の POSIX mode/uid フィールドは Windows では
 * ACL のビューにならないため、Windows は構造チェック(呼び出し側のマーカー・
 * スキーマ検証や親ディレクトリの ACL)に委ねて素通しする。
 */
export function isPrivateOwnerStat(
  stat: Stats,
  uid: number | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isWindows(platform)
    || ((stat.mode & 0o077) === 0 && (uid === undefined || stat.uid === uid));
}

/**
 * Windows native Codex hook command は quoted Node パスを PowerShell で
 * 実行するため call operator `&` が必要(v0.17.1)。POSIX は不要。
 */
export function powershellCallPrefix(platform: NodeJS.Platform = process.platform): string {
  return isWindows(platform) ? '& ' : '';
}

/** PATH 走査で node 実行ファイルとして探す名前の候補。 */
export function nodeExecutableNames(platform: NodeJS.Platform = process.platform): string[] {
  return isWindows(platform)
    ? ['node.exe', 'node.cmd', 'node.bat', 'node']
    : ['node'];
}

/**
 * ファイルシステムが case-insensitive な Windows ではパス比較用に小文字化する。
 * 呼び出し側で区切り文字の正規化(\\ → /)を済ませてから渡す。
 */
export function normalizePathCase(
  normalizedPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return isWindows(platform) ? normalizedPath.toLowerCase() : normalizedPath;
}

export interface ScheduleCommand { command: string; args: string[] }
/** Resolve the current token, never a guessed USERDOMAIN/account pair. */
export function nativeScheduleUserId(
  username: string,
  platform: NodeJS.Platform = process.platform,
  run: (command: ScheduleCommand) => { status: number; stdout: string } = command => {
    const result = spawnSync(command.command, command.args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (result.error) throw Error('schedule_identity_spawn_failed');
    return { status: result.status ?? -1, stdout: result.stdout ?? '' };
  },
  systemRoot = process.env.SystemRoot,
): string {
  if (!isWindows(platform)) return username;
  let phase: 'root' | 'spawn' | 'exit' | 'output' = 'root';
  try {
    if (!systemRoot || !win32.isAbsolute(systemRoot) || /[\x00-\x1f]/.test(systemRoot)) throw Error('schedule_system_root_unavailable');
    phase = 'spawn';
    const result = run({ command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop';try{[Console]::Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value);exit 0}catch{exit 1}"] });
    phase = 'exit';
    if (result.status !== 0) throw Error('schedule_identity_exit_failed');
    phase = 'output';
    const sid = result.stdout.trim();
    if (/^S-1-\d+(?:-\d+){1,15}$/.test(sid)) return sid;
  } catch { /* Never fall back to environment/account-name guesses. */ }
  throw Error(`schedule_user_identity_unavailable_${phase}`);
}

export interface NativeSyncSchedule {
  id: string;
  kind: 'systemd-user' | 'launchd-user' | 'windows-task';
  files: { path: string; content: string; encoding?: 'utf16le' }[];
  query: ScheduleCommand;
  inspect: ScheduleCommand;
  install: ScheduleCommand[];
  remove: ScheduleCommand[];
  reload: ScheduleCommand[];
  argv: string[];
}
/** Exact persisted bytes; absent encoding preserves legacy UTF-8 ownership. */
export function nativeScheduleFileBytes(file: NativeSyncSchedule['files'][number]): Buffer {
  if (file.encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, 'utf16le')]);
  if (file.encoding !== undefined) throw Error('schedule_definition_encoding_invalid');
  return Buffer.from(file.content, 'utf8');
}

export interface NativeSyncScheduleOptions {
  caveatHome: string; userHome: string; nodePath: string; cliPath: string;
  platform?: NodeJS.Platform; uid?: number; userId?: string;
}

const xml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const unitArg = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$')}"`;
/** Standard Windows argv quoting, without invoking cmd.exe or PowerShell. */
export function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function nativeSyncSchedule(opts: NativeSyncScheduleOptions): NativeSyncSchedule {
  const platform = opts.platform ?? process.platform;
  const absolute = platform === 'win32' ? win32.isAbsolute : isAbsolute;
  for (const value of [opts.caveatHome, opts.userHome, opts.nodePath, opts.cliPath]) {
    if (!absolute(value) || /[\x00-\x1f]/.test(value)) throw Error('schedule_absolute_path_required');
  }
  const suffix = createHash('sha256').update(normalizePathCase(opts.caveatHome, platform)).digest('hex').slice(0, 16);
  const id = `caveat-autosync-${suffix}`;
  const argv = [opts.nodePath, opts.cliPath, 'autosync', 'run', '--json', '--caveat-home', opts.caveatHome, '--user-home', opts.userHome];
  const command = (name: string, ...args: string[]): ScheduleCommand => ({ command: name, args });
  if (platform === 'linux') {
    const service = join(opts.userHome, '.config', 'systemd', 'user', `${id}.service`);
    const timer = join(opts.userHome, '.config', 'systemd', 'user', `${id}.timer`);
    return { id, kind: 'systemd-user', argv, files: [
      { path: service, content: `[Unit]\nDescription=Caveat private knowledge reception\n[Service]\nType=oneshot\nTimeoutStartSec=10min\nExecStart=${argv.map(unitArg).join(' ')}\nSuccessExitStatus=2\n` },
      { path: timer, content: `[Unit]\nDescription=Caveat reception timer\n[Timer]\nOnBootSec=60s\nOnUnitInactiveSec=60s\nUnit=${id}.service\n[Install]\nWantedBy=timers.target\n` },
    ], query: command('systemctl', '--user', 'is-active', `${id}.timer`),
    inspect: command('systemctl', '--user', 'show', `${id}.timer`, '--property=LoadState', '--value'),
    install: [command('systemctl', '--user', 'link', service, timer), command('systemctl', '--user', 'daemon-reload'), command('systemctl', '--user', 'enable', '--now', `${id}.timer`)],
    remove: [command('systemctl', '--user', 'stop', `${id}.timer`, `${id}.service`), command('systemctl', '--user', 'disable', `${id}.timer`, `${id}.service`)],
    reload: [command('systemctl', '--user', 'daemon-reload')] };
  }
  if (platform === 'darwin') {
    if (!Number.isInteger(opts.uid) || opts.uid! < 0) throw Error('schedule_uid_required');
    const label = `dev.caveat.${id}`;
    const file = join(opts.userHome, 'Library', 'LaunchAgents', `${label}.plist`);
    const domain = `gui/${opts.uid}`;
    return { id: label, kind: 'launchd-user', argv, files: [{ path: file, content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argv.map(a => `<string>${xml(a)}</string>`).join('')}</array><key>StartInterval</key><integer>60</integer></dict></plist>\n` }],
      query: command('launchctl', 'print', `${domain}/${label}`),
      inspect: command('launchctl', 'print', `${domain}/${label}`),
      install: [command('launchctl', 'bootstrap', domain, file)],
      remove: [command('launchctl', 'bootout', `${domain}/${label}`)], reload: [] };
  }
  if (platform === 'win32') {
    if (!opts.userId || /[\x00-\x1f]/.test(opts.userId)) throw Error('schedule_user_id_required');
    const file = join(opts.caveatHome, 'sync', `${id}.xml`);
    // schtasks imports a BOM-marked UTF-16LE file, matching its Unicode XML
    // declaration; BOM-less UTF-8 corrupted non-ASCII paths on Windows.
    // Daily repetition avoids locale-sensitive date arguments to schtasks.
    const content = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Caveat private knowledge reception ${id}</Description></RegistrationInfo><Triggers><CalendarTrigger><Repetition><Interval>PT1M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers><Principals><Principal id="CurrentUser"><UserId>${xml(opts.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="CurrentUser"><Exec><Command>${xml(opts.nodePath)}</Command><Arguments>${xml(argv.slice(1).map(quoteWindowsArgument).join(' '))}</Arguments></Exec></Actions></Task>\n`;
    return { id, kind: 'windows-task', argv, files: [{ path: file, content, encoding: 'utf16le' }],
      query: command('powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
        `$ErrorActionPreference = 'Stop'; try { $scheduler = New-Object -ComObject Schedule.Service; $scheduler.Connect(); $task = $scheduler.GetFolder('\\').GetTask('${id}'); $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($task.Xml); $stdout = [Console]::OpenStandardOutput(); $stdout.Write($bytes, 0, $bytes.Length); $stdout.Flush(); exit 0 } catch { exit 1 }`, 'utf16le').toString('base64')),
      inspect: command('powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        `try { $scheduler = New-Object -ComObject Schedule.Service; $scheduler.Connect(); $null = $scheduler.GetFolder('\\').GetTask('${id}'); exit 0 } catch { $failure = $_.Exception; while ($failure.InnerException) { $failure = $failure.InnerException }; if ($failure.HResult -eq -2147024894) { exit 3 }; exit 1 }`),
      install: [command('schtasks.exe', '/Create', '/TN', id, '/XML', file)],
      remove: [command('schtasks.exe', '/Delete', '/TN', id, '/F')], reload: [] };
  }
  throw Error('schedule_platform_unsupported');
}

/** Presence only; command failures are not a successful registration. */
export function nativeSchedulePresent(kind: NativeSyncSchedule['kind'], status: number, stdout: string): boolean {
  if (kind === 'systemd-user') {
    if (stdout.trim() === 'loaded') return true;
    if (stdout.trim() === 'not-found') return false;
    throw Error('schedule_inspection_failed');
  }
  if (status === 0) return true;
  if (kind === 'launchd-user' && status === 113) return false;
  // The fixed COM probe maps only HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
  // to 3. Access denial/service errors must never mean an absent task.
  if (kind === 'windows-task' && status === 3) return false;
  throw Error('schedule_inspection_failed');
}

/** Compare the native readback without depending on locale-specific error text. */
export function nativeScheduleReadbackMatches(plan: NativeSyncSchedule, stdout: string): boolean {
  if (plan.kind !== 'windows-task') return true;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: false, parseTagValue: false });
    const actual = parser.parse(stdout).Task;
    const expected = parser.parse(plan.files[0]!.content).Task;
    // Task Scheduler exports omit these schema defaults. Explicit changes still fail.
    // https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-schema
    const defaulted = (value: unknown, fallback: string) => value === undefined ? fallback : value;
    const triggerFields = (task: typeof actual) => {
      const trigger = task.Triggers.CalendarTrigger;
      return [trigger.StartBoundary, defaulted(trigger.Enabled, 'true'), trigger.ScheduleByDay.DaysInterval,
        trigger.Repetition.Interval, trigger.Repetition.Duration, defaulted(trigger.Repetition.StopAtDurationEnd, 'false')];
    };
    const values = (task: typeof actual) => [task.Actions.Exec.Command, task.Actions.Exec.Arguments,
      ...triggerFields(task), task.Principals.Principal.LogonType, defaulted(task.Principals.Principal.RunLevel, 'LeastPrivilege'),
      task.Settings.MultipleInstancesPolicy, task.Settings.ExecutionTimeLimit, defaulted(task.Settings.Enabled, 'true')];
    return JSON.stringify(values(actual)) === JSON.stringify(values(expected));
  } catch { return false; }
}

/** systemd can load linked units before enabling their timer succeeds. */
export function nativeScheduleCanRecover(plan: NativeSyncSchedule, readback: () => boolean): boolean {
  return plan.kind === 'systemd-user' || readback();
}
