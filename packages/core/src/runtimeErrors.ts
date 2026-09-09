import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch as hostArch, homedir, platform as hostPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.js';
import { isWindowsEnv } from './platform.js';

export const RUNTIME_ERRORS_SCHEMA = 'caveat.runtime_errors.v1';
const STATE_VERSION = '1.0';
const MAX_RECORDS = 256;
const RETENTION_MS = 30 * 86_400_000;
const definitions = {
  'CAVEAT.DATABASE_OPEN_FAILED': { component: 'database', severity: 'high', template: 'Caveat database open failed' },
  'CAVEAT.INDEX_FAILED': { component: 'index', severity: 'high', template: 'Caveat index operation failed' },
  'CAVEAT.SYNC_FAILED': { component: 'sync', severity: 'high', template: 'Caveat own sync failed' },
  'CAVEAT.MCP_SERVER_FAILED': { component: 'mcp', severity: 'high', template: 'Caveat MCP server failed' },
  'CAVEAT.MCP_TOOL_FAILED': { component: 'mcp_tool', severity: 'high', template: 'Caveat MCP tool handler failed' },
  'CAVEAT.CLAUDE_HOOK_FAILED': { component: 'claude_hook', severity: 'high', template: 'Caveat Claude hook failed' },
  'CAVEAT.CODEX_HOOK_FAILED': { component: 'codex_hook', severity: 'high', template: 'Caveat Codex hook failed' },
  'CAVEAT.CURSOR_HOOK_FAILED': { component: 'cursor_hook', severity: 'high', template: 'Caveat Cursor hook failed' },
} as const;
export type RuntimeErrorCode = keyof typeof definitions;
type Status = 'open' | 'resolved';
type RecordEntry = { product: 'caveat'; product_version: string; component: string; error_code: RuntimeErrorCode; message_template: string; severity: string; fingerprint: string; count: number; first_seen: string; last_seen: string; state_schema_version: typeof STATE_VERSION; os: string; arch: string; status: Status; resolved_at: string | null; reason_code: 'operator_resolved' | null; sequence: number };
type Store = { schema: typeof RUNTIME_ERRORS_SCHEMA; next_sequence: number; acknowledged_through: number; records: RecordEntry[] };
export type RuntimeErrorOptions = { env?: NodeJS.ProcessEnv; configPath?: string; storePath?: string; now?: string; version?: string; os?: string; arch?: string; isWindows?: (env: NodeJS.ProcessEnv) => boolean; aclRunner?: (path: string, directory: boolean, apply: boolean) => void };
function normalizeOptions(options: RuntimeErrorOptions | NodeJS.ProcessEnv = {}): RuntimeErrorOptions {
  return ('env' in options || 'configPath' in options || 'storePath' in options || 'version' in options || 'isWindows' in options) ? options as RuntimeErrorOptions : { env: options as NodeJS.ProcessEnv };
}

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const validTime = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const validVersion = (v: unknown) => typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);
const validOs = (v: unknown) => typeof v === 'string' && ['darwin', 'linux', 'windows'].includes(v);
const validArch = (v: unknown) => typeof v === 'string' && ['x64', 'arm64', 'arm', 'ia32'].includes(v);
const windows = (env: NodeJS.ProcessEnv) => isWindowsEnv(env, hostPlatform());

export function runtimeErrorsConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const home = windows(env)
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || env.USERPROFILE || homedir();
  return join(home, '.caveatrc.json');
}
export function runtimeErrorsStatePath(env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return windows(env) ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'caveat', 'runtime-errors.json') : join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'caveat', 'runtime-errors.json');
}
function collectionEnabled(options: RuntimeErrorOptions = {}) {
  const env = options.env ?? process.env;
  try {
    const path = options.configPath ?? runtimeErrorsConfigPath(env);
    return loadConfig(path).runtimeErrors === true;
  } catch { return false; }
}
export function runtimeCollectionEnabled(env: NodeJS.ProcessEnv = process.env, configPath?: string) { return collectionEnabled({ env, configPath }); }
const empty = (): Store => ({ schema: RUNTIME_ERRORS_SCHEMA, next_sequence: 1, acknowledged_through: 0, records: [] });
function fingerprint(code: RuntimeErrorCode) { const d = definitions[code]; return createHash('sha256').update(`caveat\0${d.component}\0${code}\0${d.template}`).digest('hex'); }
function ensureSafeDir(dir: string, isWin: boolean, options: RuntimeErrorOptions = {}) { const existed = existsSync(dir); mkdirSync(dir, { recursive: true, mode: 0o700 }); const s = lstatSync(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('store_unsafe'); if (isWin) secureWindowsAcl(dir, options.aclRunner, true, !existed); else assertPosix(s, 0o700); }
const WINDOWS_ACL_VERIFY = String.raw`$ErrorActionPreference='Stop';$p=$env:CAVEAT_ACL_PATH;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $p;$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;if($owner -ne $sid){exit 41};$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));if($rules.Count -ne 1){exit 42};$r=$rules[0];if($r.IdentityReference.Value -ne $sid -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited -or ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 43}`;
const WINDOWS_ACL_APPLY = String.raw`$ErrorActionPreference='Stop';$p=$env:CAVEAT_ACL_PATH;$isDir=$env:CAVEAT_ACL_DIRECTORY -eq '1';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=if($isDir){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity};$acl.SetAccessRuleProtection($true,$false);$flags=if($isDir){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None};$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$acl.SetOwner($sid);$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl;` + WINDOWS_ACL_VERIFY;
// Hang guard, not a latency budget, and sized against the slowest machine that
// runs it rather than a developer box.
//
// The old 3s bound is what made this seam flake: on a contended Windows CI
// runner a single apply can cross it, spawnSync kills powershell,
// and the null exit status read as "unsafe ACL". Measured on the actual
// runners, one apply costs 331-459ms across 160 isolated runs, but the same
// test costs 1042-1319ms inside the full parallel suite and the file it lives
// in takes 47-61s overall — so 3s left barely 2.5x headroom against a runner
// under load. A later windows-2022 run exhausted the former 15s guard while
// PowerShell was starting, without returning an ACL rejection. 30s remains a
// bounded hang guard while giving the hosted runner cold start enough room.
// Re-measure before changing it; a fast idle box will lie to you.
const WINDOWS_ACL_TIMEOUT_MS = 30_000;
export function runWindowsAcl(path: string, directory: boolean, apply: boolean) {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', apply ? WINDOWS_ACL_APPLY : WINDOWS_ACL_VERIFY], { env: { ...process.env, CAVEAT_ACL_PATH: path, CAVEAT_ACL_DIRECTORY: directory ? '1' : '0' }, encoding: 'utf-8', timeout: WINDOWS_ACL_TIMEOUT_MS, windowsHide: true });
  // 起動失敗・timeout・ACL拒否を区別し、外向きのstore_unsafeにはcauseとして保持する。
  // pathとstderrは内部診断だけに残し、収集レコードには保存しない。
  if (result.error !== undefined) throw Error(`store_unsafe: powershell spawn ${(result.error as NodeJS.ErrnoException).code ?? result.error.message}`);
  if (result.status !== 0) throw Error(`store_unsafe: powershell exit=${result.status} signal=${result.signal ?? 'none'} stderr=${(result.stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) || '(empty)'}`);
}
function secureWindowsAcl(path: string, runner: RuntimeErrorOptions['aclRunner'], directory = false, apply = false) { try { (runner ?? runWindowsAcl)(path, directory, apply); } catch (cause) { throw Error('store_unsafe', { cause }); } }
function assertPosix(info: { mode: number; uid: number }, mode: number) { if ((info.mode & 0o777) !== mode || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('store_unsafe'); }
function ensureSafeFile(path: string, isWin: boolean, options: RuntimeErrorOptions = {}) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) throw Error('store_unsafe'); if (isWin) secureWindowsAcl(path, options.aclRunner); else assertPosix(statSync(path), 0o600); }
function validate(store: unknown): asserts store is Store {
  if (!plain(store) || !exact(store, ['schema', 'next_sequence', 'acknowledged_through', 'records'])) throw Error('state_invalid');
  const checked = store as Store;
  if (checked.schema !== RUNTIME_ERRORS_SCHEMA || !Number.isSafeInteger(checked.next_sequence) || checked.next_sequence < 1 || !Number.isSafeInteger(checked.acknowledged_through) || checked.acknowledged_through < 0 || checked.acknowledged_through >= checked.next_sequence || !Array.isArray(checked.records) || checked.records.length > MAX_RECORDS) throw Error('state_invalid');
  const seen = new Set<string>(); let previous = 0;
  for (const record of checked.records) {
    if (!plain(record) || !exact(record, ['product','product_version','component','error_code','message_template','severity','fingerprint','count','first_seen','last_seen','state_schema_version','os','arch','status','resolved_at','reason_code','sequence'])) throw Error('state_invalid');
    const code = typeof record.error_code === 'string' ? record.error_code as RuntimeErrorCode : undefined; const d = code && definitions[code];
    if (!d || record.product !== 'caveat' || !validVersion(record.product_version) || record.component !== d.component || record.message_template !== d.template || record.severity !== d.severity || record.fingerprint !== fingerprint(code) || seen.has(record.fingerprint) || !Number.isSafeInteger(record.count) || record.count < 1 || !validTime(record.first_seen) || !validTime(record.last_seen) || Date.parse(record.first_seen) > Date.parse(record.last_seen) || record.state_schema_version !== STATE_VERSION || !validOs(record.os) || !validArch(record.arch) || !Number.isSafeInteger(record.sequence) || record.sequence <= previous || record.sequence >= checked.next_sequence || !['open','resolved'].includes(record.status as string) || (record.status === 'open' && (record.resolved_at !== null || record.reason_code !== null)) || (record.status === 'resolved' && (typeof record.resolved_at !== 'string' || !validTime(record.resolved_at) || Date.parse(record.resolved_at) < Date.parse(record.last_seen) || record.reason_code !== 'operator_resolved'))) throw Error('state_invalid');
    seen.add(record.fingerprint); previous = record.sequence;
  }
}
function readStore(path: string, isWin: boolean, options: RuntimeErrorOptions = {}): Store { if (!existsSync(path)) return empty(); ensureSafeFile(path, isWin, options); const value: unknown = JSON.parse(readFileSync(path, 'utf8')); validate(value); return value; }
function lock<T>(path: string, isWin: boolean, fn: () => T, options: RuntimeErrorOptions = {}): T { ensureSafeDir(dirname(path), isWin, options); const lockPath = `${path}.lock.sqlite`; let created = false; try { writeFileSync(lockPath, '', { mode: 0o600, flag: 'wx' }); created = true; } catch (error) { if (!plain(error) || error.code !== 'EEXIST') throw error; } if (created) { if (isWin) secureWindowsAcl(lockPath, options.aclRunner, false, true); else assertPosix(statSync(lockPath), 0o600); } else ensureSafeFile(lockPath, isWin, options); const db = new DatabaseSync(lockPath); let begun = false; try { ensureSafeFile(lockPath, isWin, options); db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE'); begun = true; const result = fn(); db.exec('COMMIT'); begun = false; return result; } finally { if (begun) try { db.exec('ROLLBACK'); } catch {} db.close(); } }
function writeStore(path: string, store: Store, isWin: boolean, options: RuntimeErrorOptions = {}) { validate(store); ensureSafeDir(dirname(path), isWin, options); const temporary = join(dirname(path), `.runtime-errors-${process.pid}-${randomBytes(6).toString('hex')}`); try { writeFileSync(temporary, `${JSON.stringify(store)}\n`, { mode: 0o600, flag: 'wx' }); if (isWin) secureWindowsAcl(temporary, options.aclRunner, false, true); else assertPosix(statSync(temporary), 0o600); renameSync(temporary, path); ensureSafeFile(path, isWin, options); } finally { rmSync(temporary, { force: true }); } }
function now(options: RuntimeErrorOptions) { const value = options.now ? new Date(options.now) : new Date(); if (Number.isNaN(value.valueOf())) throw Error('invalid_time'); return value.toISOString(); }
function normalizeOs(value: string) { return value === 'win32' ? 'windows' : value; }
function optionsFor(options: RuntimeErrorOptions) { const env = options.env ?? process.env; const isWin = (options.isWindows ?? windows)(env); return { env, isWin, path: options.storePath ?? runtimeErrorsStatePath(env) }; }
function requireCursor(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid_cursor'); }
function requireLimit(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RECORDS) throw Error('invalid_limit'); }
function snapshot(options: RuntimeErrorOptions & { afterCursor?: number; limit?: number } = {}) {
  const afterCursor = options.afterCursor ?? 0, limit = options.limit ?? MAX_RECORDS; requireCursor(afterCursor); requireLimit(limit);
  const enabled = collectionEnabled(options); const { path, isWin } = optionsFor(options); const store = enabled ? readStore(path, isWin, options) : empty();
  if (afterCursor > store.next_sequence - 1) throw Error('invalid_cursor');
  const all = store.records.filter((r) => r.sequence > afterCursor); const rows = all.slice(0, limit);
  return { schema: RUNTIME_ERRORS_SCHEMA, product: 'caveat', version: options.version ?? 'unknown', state_schema_version: STATE_VERSION, cursor: { high_watermark: store.next_sequence - 1, acknowledged_through: store.acknowledged_through, next: rows.at(-1)?.sequence ?? afterCursor }, runtime_errors: rows.filter((r) => r.status === 'open').map(({ error_code, component, status, severity, fingerprint, message_template, count, first_seen, last_seen, state_schema_version }) => ({ error_code, component, status, severity, fingerprint, message_template, occurrence_count: count, first_seen, last_seen, state_schema_version })), resolutions: rows.filter((r) => r.status === 'resolved').map(({ fingerprint, resolved_at, reason_code }) => ({ fingerprint, resolved_at, reason_code })), diagnostics: { collection: enabled ? 'enabled' : 'disabled', status: enabled ? 'ready' : 'not_applicable', total_count: store.records.length, pending_count: store.records.filter((r) => r.sequence > store.acknowledged_through).length, truncated: all.length > rows.length } };
}
export function runtimeErrorsDiagnostics(options: RuntimeErrorOptions = {}) {
  if (!collectionEnabled(options)) return { schema: 'caveat.runtime_error_diagnostics.v1', collection: 'disabled', status: 'not_applicable', total_count: 0, open_count: 0, pending_count: 0, high_watermark: 0, acknowledged_through: 0 };
  try { const { path, isWin } = optionsFor(options); const store = readStore(path, isWin, options); return { schema: 'caveat.runtime_error_diagnostics.v1', collection: 'enabled', status: 'ready', total_count: store.records.length, open_count: store.records.filter((record) => record.status === 'open').length, pending_count: store.records.filter((record) => record.sequence > store.acknowledged_through).length, high_watermark: store.next_sequence - 1, acknowledged_through: store.acknowledged_through }; }
  catch { return { schema: 'caveat.runtime_error_diagnostics.v1', collection: 'enabled', status: 'unavailable', total_count: 0, open_count: 0, pending_count: 0, high_watermark: 0, acknowledged_through: 0 }; }
}
export function recordRuntimeError(code: RuntimeErrorCode, options: RuntimeErrorOptions = {}) {
  if (!collectionEnabled(options)) return { status: 'disabled' as const };
  const { path, isWin } = optionsFor(options); return lock(path, isWin, () => { const store = readStore(path, isWin, options); const definition = definitions[code]; if (!definition) throw Error('unknown_runtime_code'); const key = fingerprint(code); const sequence = store.next_sequence++; const time = now(options); const existing = store.records.find((r) => r.fingerprint === key);
    const version = options.version ?? '0.0.0'; const os = normalizeOs(options.os ?? hostPlatform()); const arch = options.arch ?? hostArch(); if (!validVersion(version) || !validOs(os) || !validArch(arch)) throw Error('invalid_runtime_metadata');
    if (existing) { existing.product_version = version; existing.os = os; existing.arch = arch; existing.count += 1; existing.last_seen = time; existing.sequence = sequence; existing.status = 'open'; existing.resolved_at = null; existing.reason_code = null; }
    else { if (store.records.length >= MAX_RECORDS) throw Error('store_overflow'); store.records.push({ product: 'caveat', product_version: version, component: definition.component, error_code: code, message_template: definition.template, severity: definition.severity, fingerprint: key, count: 1, first_seen: time, last_seen: time, state_schema_version: STATE_VERSION, os, arch, status: 'open', resolved_at: null, reason_code: null, sequence }); }
    store.records.sort((a, b) => a.sequence - b.sequence); writeStore(path, store, isWin, options); return { status: 'recorded' as const, fingerprint: key, sequence }; }, options);
}
export function observeRuntimeError(code: RuntimeErrorCode, options: RuntimeErrorOptions = {}) { try { recordRuntimeError(code, options); } catch { try { process.stderr.write('[caveat:runtime-errors] store_unavailable\n'); } catch {} } }
export const runtimeErrorsSnapshot = (afterCursor = 0, limit = MAX_RECORDS, options: RuntimeErrorOptions | NodeJS.ProcessEnv = {}) => snapshot({ ...normalizeOptions(options), afterCursor, limit });
export function acknowledgeRuntimeErrors(cursor: number, options: RuntimeErrorOptions | NodeJS.ProcessEnv = {}) { const normalized = normalizeOptions(options); requireCursor(cursor); if (!collectionEnabled(normalized)) return snapshot({ ...normalized, afterCursor: cursor }); const { path, isWin } = optionsFor(normalized); lock(path, isWin, () => { const store = readStore(path, isWin, normalized); if (cursor >= store.next_sequence) throw Error('invalid_cursor'); store.acknowledged_through = Math.max(store.acknowledged_through, cursor); writeStore(path, store, isWin, normalized); }, normalized); return snapshot(normalized); }
export function setRuntimeErrorStatus(fingerprintValue: string, status: Status, options: RuntimeErrorOptions | NodeJS.ProcessEnv = {}) { const normalized = normalizeOptions(options); if (!/^[0-9a-f]{64}$/.test(fingerprintValue)) throw Error('invalid_fingerprint'); if (!collectionEnabled(normalized)) return snapshot(normalized); const { path, isWin } = optionsFor(normalized); lock(path, isWin, () => { const store = readStore(path, isWin, normalized); const record = store.records.find((r) => r.fingerprint === fingerprintValue); if (!record) throw Error('fingerprint_not_found'); if (record.status === status) return; record.status = status; record.resolved_at = status === 'resolved' ? now(normalized) : null; record.reason_code = status === 'resolved' ? 'operator_resolved' : null; record.sequence = store.next_sequence++; store.records.sort((a, b) => a.sequence - b.sequence); writeStore(path, store, isWin, normalized); }, normalized); return snapshot(normalized); }
export function compactRuntimeErrors(options: RuntimeErrorOptions | NodeJS.ProcessEnv = {}) { const normalized = normalizeOptions(options); if (!collectionEnabled(normalized)) return snapshot(normalized); const { path, isWin } = optionsFor(normalized); lock(path, isWin, () => { const store = readStore(path, isWin, normalized); const cutoff = Date.parse(now(normalized)) - RETENTION_MS; store.records = store.records.filter((record) => !(record.status === 'resolved' && record.sequence <= store.acknowledged_through && record.resolved_at !== null && Date.parse(record.resolved_at) <= cutoff)); writeStore(path, store, isWin, normalized); }, normalized); return snapshot(normalized); }
export const runtimeErrorsInternal = { validate, definitions };
