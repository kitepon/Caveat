import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isWindows } from './platform.js';
import { managedDeploymentPaths, verifyManagedDeployment, type ManagedDeploymentOptions } from './managedDeployment.js';
import { runWindowsAclVerifyPrivateTree, WINDOWS_ACL_TIMEOUT_MS } from './privateWindowsAcl.js';

const schema = 'caveat.managed_shell.v1';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason: string): never => { throw Error('managed_shell_' + reason); };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function literal(value: string, windows: boolean) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || !(windows ? win32.isAbsolute(value) : isAbsolute(value))) fail('absolute_path_required');
  if (windows && /["%!^&|<>]/.test(value)) fail('unsupported_windows_path');
}

/** Contents only: no PATH lookup, host writes, or pointer/registration changes. */
export function renderManagedShellWrappers(node: string, entry: string, windows = isWindows()) {
  if (node !== 'node') literal(node, windows); literal(entry, windows);
  const posix = windows ? [node, entry].map(value => value.replaceAll('\\', '/')) : [node, entry];
  const missing = 'Caveat requires Node 22.16+ (22.x) or Node 24+. Install a current Node LTS from https://nodejs.org/en/download, then reopen your AI client.';
  const checkNode = node === 'node' ? 'command -v node >/dev/null 2>&1 || { echo ' + quote(missing) + ' >&2; exit 127; }\n' : '';
  const files = [{ name: 'caveat', content: '#!/bin/sh\n' + checkNode + 'exec ' + posix.map(quote).join(' ') + ' "$@"\n' }];
  if (windows) {
    // shortcut: cmd bootstrap needs an ASCII Node path; reject other paths until a native Unicode launcher is adopted.
    if (/[^\x20-\x7e]/.test(node)) fail('unsupported_windows_node_path');
    // ASCII batch bytes cannot corrupt a Unicode entry path; the fixed Node child receives its absolute argv.
    const bootstrap = "const c=require('node:child_process').spawnSync(process.execPath,[Buffer.from('" + Buffer.from(entry).toString('base64') + "','base64').toString('utf8'),...process.argv.slice(1)],{stdio:'inherit'});if(c.error){console.error(c.error.message);process.exit(1)}process.exit(c.status===null?1:c.status)";
    files.push({ name: 'caveat.cmd', content: '@echo off\r\n' + (node === 'node' ? 'where node >nul 2>nul\r\nif errorlevel 1 (echo ' + missing + ' 1>&2 & exit /b 127)\r\n' : '') + '"' + node + '" -e "' + bootstrap + '" -- %*\r\nexit /b %errorlevel%\r\n' });
    // ProcessStartInfo inherits native stdio; a PowerShell pipeline would decode bytes.
    // Quote for CreateProcess also on Windows PowerShell 5.1 (no ArgumentList).
    const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      ...(node === 'node' ? ["if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw " + psQuote(missing) + " }"] : []),
      '$start = New-Object System.Diagnostics.ProcessStartInfo',
      '$start.UseShellExecute = $false',
      '$start.FileName = ' + psQuote(node),
      '$values = @(' + psQuote(entry) + ') + @($args)',
      '$start.Arguments = (($values | ForEach-Object {',
      '  $value = [regex]::Replace([string]$_, \'(\\\\*)"\', \'$1$1\\"\')',
      '  \'"\' + [regex]::Replace($value, \'(\\\\+)$\', \'$1$1\') + \'"\'',
      "}) -join ' ')",
      '$child = [System.Diagnostics.Process]::Start($start)',
      '$child.WaitForExit()', '$code = $child.ExitCode', '$child.Dispose()', 'exit $code', '',
    ];
    files.push({ name: 'caveat.ps1', content: '\uFEFF' + ps.join('\r\n') });
  }
  return files.map(file => ({ ...file, sha256: sha(file.content) }));
}

type Identity = { dev: string; ino: string; uid: number; gid: number; mode: number; realpath: string };
type NativeIdentity = { owner: string; aclSha256: string; ownerIsCurrent: boolean };
export type ManagedShellPlan = { schema: typeof schema; registrationNode: string; launcher: string; entrySha256: string; runtimeSha256: string; binDir: string; windows: boolean; files: { name: string; path: string; content: string; sha256: string }[] };
export type ManagedShellManifest = Omit<ManagedShellPlan, 'files'> & { binIdentity: Identity; files: { name: string; path: string; sha256: string; identity: Identity; native: NativeIdentity | null }[] };
function identity(path: string, directory: boolean): Identity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail('redirect_or_nonregular');
  return { dev: String(stat.dev), ino: String(stat.ino), uid: Number(stat.uid), gid: Number(stat.gid), mode: Number(stat.mode & 0o777n), realpath: realpathSync(path) };
}
function readRegular(path: string, limit: number) {
  const before = identity(path, false), fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino || stat.size > BigInt(limit)) fail('file_changed_or_oversized');
    const buffer = Buffer.alloc(limit + 1); let count = 0;
    while (count <= limit) { const n = readSync(fd, buffer, count, buffer.length - count, null); if (n === 0) break; count += n; }
    if (count > limit) fail('file_changed_or_oversized');
    const bytes = buffer.subarray(0, count), after = fstatSync(fd, { bigint: true });
    if (stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs || JSON.stringify(identity(path, false)) !== JSON.stringify(before)) fail('concurrent_change');
    return { bytes, identity: before };
  } finally { closeSync(fd); }
}
function nativeIdentities(paths: string[]): NativeIdentity[] {
  const script = String.raw`$ErrorActionPreference='Stop';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$result=@();foreach($p in (ConvertFrom-Json $env:CAVEAT_SHELL_PATHS)){$acl=Get-Acl -LiteralPath $p;$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;$trusted=@($sid,'S-1-5-18','S-1-5-32-544');$mask=[System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership';foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band $mask) -ne 0 -and $r.IdentityReference.Value -notin $trusted){throw 'foreign_writer'}};$hash=[System.Security.Cryptography.SHA256]::Create();try{$digest=[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($acl.Sddl))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()};$result+=@{owner=$owner;aclSha256=$digest;ownerIsCurrent=($owner -eq $sid)}};ConvertTo-Json -InputObject @($result) -Compress`;
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CAVEAT_SHELL_PATHS: JSON.stringify(paths) }, encoding: 'utf8', timeout: WINDOWS_ACL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) fail('native_identity_unavailable');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== paths.length || rows.some(row => typeof row?.owner !== 'string' || !/^S-1-/.test(row.owner) || !/^[a-f0-9]{64}$/.test(row.aclSha256) || typeof row.ownerIsCurrent !== 'boolean')) fail('native_identity_invalid');
  return rows as NativeIdentity[];
}

export function managedShellPlan(registrationNode: string, binDir: string, options: ManagedDeploymentOptions = {}): ManagedShellPlan {
  const active = verifyManagedDeployment(options), windows = options.windows ?? isWindows();
  if (registrationNode !== 'node') literal(registrationNode, windows);
  if (!isAbsolute(binDir)) fail('absolute_bin_required');
  binDir = resolve(binDir);
  const entry = readRegular(active.launcher, 1024 * 1024);
  const runtime = readRegular(join(dirname(active.launcher), 'managed-deployment.js'), 1024 * 1024);
  if (active.manifest.files.find(file => file.path === 'dist/stable-entry.mjs')?.sha256 !== sha(entry.bytes)
    || active.manifest.files.find(file => file.path === 'dist/managed-deployment.js')?.sha256 !== sha(runtime.bytes)) fail('entry_changed');
  return { schema, registrationNode, launcher: active.launcher, entrySha256: sha(entry.bytes), runtimeSha256: sha(runtime.bytes), binDir, windows,
    files: renderManagedShellWrappers(registrationNode, active.launcher, windows).map(file => ({ ...file, path: join(binDir, file.name) })) };
}
/** Read back already-installed leaves; caller records this in the protected root after product-owned acceptance. */
export function captureManagedShellManifest(plan: ManagedShellPlan): ManagedShellManifest {
  const windows = isWindows();
  if (plan.schema !== schema || plan.windows !== windows) fail('invalid_plan');
  const generated = renderManagedShellWrappers(plan.registrationNode, plan.launcher, windows);
  if (sha(readRegular(plan.launcher, 1024 * 1024).bytes) !== plan.entrySha256 || sha(readRegular(join(dirname(plan.launcher), 'managed-deployment.js'), 1024 * 1024).bytes) !== plan.runtimeSha256 || plan.files.length !== generated.length) fail('entry_or_plan_changed');
  const binIdentity = identity(plan.binDir, true);
  for (const [index, file] of plan.files.entries()) {
    const expected = generated[index]!;
    if (file.name !== expected.name || file.path !== join(plan.binDir, expected.name) || file.sha256 !== expected.sha256 || file.content !== expected.content) fail('invalid_plan');
  }
  const snapshots = plan.files.map(file => readRegular(file.path, 64 * 1024));
  const native = windows ? nativeIdentities(plan.files.map(file => file.path)) : [];
  const files = plan.files.map((file, index) => {
    const expected = generated[index]!;
    if (file.name !== expected.name || file.path !== join(plan.binDir, expected.name) || file.sha256 !== expected.sha256 || file.content !== expected.content) fail('invalid_plan');
    const actual = snapshots[index]!;
    if (sha(actual.bytes) !== expected.sha256) fail('wrapper_bytes_changed');
    if (windows ? !native[index]!.ownerIsCurrent : actual.identity.uid !== process.getuid?.() || (actual.identity.mode & 0o022) !== 0 || (actual.identity.mode & 0o111) === 0) fail('wrapper_owner_or_mode');
    return { name: file.name, path: file.path, sha256: file.sha256, identity: actual.identity, native: native[index] ?? null };
  });
  return { schema, registrationNode: plan.registrationNode, launcher: plan.launcher, entrySha256: plan.entrySha256, runtimeSha256: plan.runtimeSha256, binDir: plan.binDir, windows, binIdentity, files };
}

/** Diagnosis only; an overwritten package-manager leaf is never repaired or used as a fallback. */
export function managedShellStatus(options: ManagedDeploymentOptions = {}) {
  const root = managedDeploymentPaths(options.userHome, options.root).root;
  const manifestPath = join(root, 'shell', 'manifest.json');
  try {
    try { lstatSync(dirname(manifestPath)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not-installed' as const }; throw error; }
    const directory = identity(dirname(manifestPath), true);
    try { lstatSync(manifestPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'changed' as const, reason: 'ownership_manifest_missing' }; throw error; }
    verifyManagedDeployment(options);
    if (!(options.windows ?? isWindows()) && (directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0)) fail('manifest_owner_or_mode');
    if (options.windows ?? isWindows()) (options.aclVerifyTreeRunner ?? runWindowsAclVerifyPrivateTree)(dirname(manifestPath));
    const saved = readRegular(manifestPath, 64 * 1024);
    if (!(options.windows ?? isWindows()) && (saved.identity.uid !== process.getuid?.() || (saved.identity.mode & 0o022) !== 0)) fail('manifest_owner_or_mode');
    const manifest = JSON.parse(saved.bytes.toString()) as ManagedShellManifest;
    if (!manifest || typeof manifest !== 'object' || manifest.schema !== schema || manifest.windows !== (options.windows ?? isWindows()) || !Array.isArray(manifest.files)) fail('invalid_manifest');
    const plan = managedShellPlan(manifest.registrationNode, manifest.binDir, options);
    const expectedKeys = ['schema','registrationNode','launcher','entrySha256','runtimeSha256','binDir','windows','binIdentity','files'].sort();
    if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)) fail('invalid_manifest');
    if (manifest.launcher !== plan.launcher || manifest.entrySha256 !== plan.entrySha256 || manifest.runtimeSha256 !== plan.runtimeSha256) return { status: 'changed' as const, reason: 'entry_changed' };
    const actual = captureManagedShellManifest(plan);
    if (!isDeepStrictEqual(manifest, actual)) return { status: 'changed' as const, reason: 'ownership_or_identity_changed' };
    return { status: 'ready' as const, manifest: manifestPath, wrappers: actual.files.map(file => ({ path: file.path, sha256: file.sha256 })) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'changed' as const, reason: 'wrapper_missing' };
    const reason = error instanceof SyntaxError ? 'invalid_manifest_json' : String(code ?? (error as Error).message);
    if (reason === 'managed_shell_entry_changed') return { status: 'changed' as const, reason: 'entry_changed' };
    return { status: reason === 'managed_shell_wrapper_bytes_changed' || reason === 'managed_shell_redirect_or_nonregular' || reason === 'managed_shell_wrapper_owner_or_mode' ? 'changed' as const : 'unknown' as const, reason };
  }
}
