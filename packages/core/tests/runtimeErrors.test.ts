import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acknowledgeRuntimeErrors, compactRuntimeErrors, recordRuntimeError, runtimeCollectionEnabled, runtimeErrorsConfigPath, runtimeErrorsDiagnostics, runtimeErrorsInternal, runtimeErrorsSnapshot, runtimeErrorsStatePath, setRuntimeErrorStatus } from '../src/runtimeErrors.js';

function env(root: string, enabled: unknown): NodeJS.ProcessEnv {
  const configHome = join(root, 'config');
  const result = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: join(root, 'state') };
  const config = runtimeErrorsConfigPath(result);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ runtimeErrors: enabled }));
  return result;
}
function configPath(root: string) { return runtimeErrorsConfigPath(absentEnv(root)); }
function absentEnv(root: string): NodeJS.ProcessEnv { return { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') }; }
const definition = 'CAVEAT.DATABASE_OPEN_FAILED' as const;

function child(args: string[], env: NodeJS.ProcessEnv) {
  const fixture = new URL('./fixtures/runtime-error-child.mjs', import.meta.url);
  const tsxLoader = fileURLToPath(new URL('../../../apps/cli/node_modules/tsx/dist/loader.mjs', import.meta.url));
  return spawn(process.execPath, ['--import', tsxLoader, fileURLToPath(fixture), ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function childExit(childProcess: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('runtime errors', { timeout: process.platform === 'win32' ? 60_000 : 5_000 }, () => {
  it('発生版は直近の発生で更新し、snapshotの実行版から推測しない', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true);
    recordRuntimeError(definition, { env: e, version: '1.0.0', now: '2026-09-01T00:00:00.000Z' });
    expect(runtimeErrorsSnapshot(0, 256, { env: e, version: '2.0.0' }).runtime_errors[0]?.product_version).toBe('1.0.0');
    recordRuntimeError(definition, { env: e, version: '2.0.0', now: '2026-09-02T00:00:00.000Z' });
    const entry = runtimeErrorsSnapshot(0, 256, { env: e, version: '3.0.0' }).runtime_errors[0];
    expect(entry?.product_version).toBe('2.0.0');
    expect(entry?.occurrence_count).toBe(2);
    expect(entry?.last_seen).toBe('2026-09-02T00:00:00.000Z');
  });
  it('uses the Caveat user config and keeps existing configs disabled until explicitly enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = absentEnv(root); const path = runtimeErrorsConfigPath(e);
    expect(path).toBe(join(root, '.caveatrc.json'));
    writeFileSync(path, JSON.stringify({ knowledgeRepo: 'own' }));
    expect(runtimeCollectionEnabled(e)).toBe(false);
    writeFileSync(path, JSON.stringify({ knowledgeRepo: 'own', runtimeErrors: true }));
    expect(runtimeCollectionEnabled(e)).toBe(true);
  });
  it('uses USERPROFILE for the Windows user config when HOME differs', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const home = join(root, 'home'); const userProfile = join(root, 'profile');
    const e = { ...process.env, OS: 'Windows_NT', HOME: home, USERPROFILE: userProfile, LOCALAPPDATA: join(root, 'local-app-data') };
    mkdirSync(home, { recursive: true }); mkdirSync(userProfile, { recursive: true });
    writeFileSync(join(home, '.caveatrc.json'), JSON.stringify({ runtimeErrors: false }));
    writeFileSync(join(userProfile, '.caveatrc.json'), JSON.stringify({ runtimeErrors: true }));
    expect(runtimeErrorsConfigPath(e)).toBe(join(userProfile, '.caveatrc.json'));
    expect(runtimeCollectionEnabled(e)).toBe(true);
  });
  it('is strictly opt-in and creates no state while disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, false);
    expect(runtimeCollectionEnabled(e)).toBe(false); recordRuntimeError(definition, { env: e });
    expect(existsSync(runtimeErrorsStatePath(e))).toBe(false);
    expect(runtimeErrorsSnapshot(0, 256, e).diagnostics.collection).toBe('disabled');
  });
  it('fails closed without creating state for absent, malformed, invalid-shape config and unsafe fresh state paths', () => {
    const absentRoot = mkdtempSync(join(tmpdir(), 'caveat-runtime-'));
    const absent = absentEnv(absentRoot);
    recordRuntimeError(definition, { env: absent });
    expect(existsSync(runtimeErrorsStatePath(absent))).toBe(false);

    for (const configBody of ['{bad', JSON.stringify({ runtimeErrors: 'true' }), JSON.stringify({ runtimeErrors: { enabled: true } })]) {
      const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true);
      writeFileSync(configPath(root), configBody);
      recordRuntimeError(definition, { env: e });
      expect(existsSync(runtimeErrorsStatePath(e))).toBe(false);
    }

    if (process.platform !== 'win32') {
      const modeRoot = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const modeEnv = env(modeRoot, true); const modeDir = join(modeRoot, 'state', 'caveat');
      mkdirSync(modeDir, { recursive: true }); chmodSync(modeDir, 0o755);
      expect(() => recordRuntimeError(definition, { env: modeEnv })).toThrow('store_unsafe');
      expect(existsSync(runtimeErrorsStatePath(modeEnv))).toBe(false);

      const symlinkRoot = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const symlinkEnv = env(symlinkRoot, true); const stateDir = join(symlinkRoot, 'state'); const target = join(symlinkRoot, 'target');
      mkdirSync(stateDir, { recursive: true }); mkdirSync(target, { recursive: true }); symlinkSync(target, join(stateDir, 'caveat'));
      expect(() => recordRuntimeError(definition, { env: symlinkEnv })).toThrow('store_unsafe');
      expect(existsSync(runtimeErrorsStatePath(symlinkEnv))).toBe(false);
    }
  });
  it('deduplicates allowlisted errors and only exposes safe structured fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true);
    recordRuntimeError(definition, { env: e }); recordRuntimeError(definition, { env: e });
    const snapshot = runtimeErrorsSnapshot(0, 256, e);
    expect(snapshot.runtime_errors).toHaveLength(1); expect(snapshot.runtime_errors[0]?.occurrence_count).toBe(2);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|cookie|stack|stderr|\/Users\//i);
    const stored = readFileSync(runtimeErrorsStatePath(e), 'utf8'); expect(stored).not.toMatch(/token|cookie|stack|stderr/i);
  });
  it('acknowledges and resolves by monotonic cursor without deleting open records', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true);
    recordRuntimeError(definition, { env: e }); const before = runtimeErrorsSnapshot(0, 256, e); const row = before.runtime_errors[0]!;
    acknowledgeRuntimeErrors(before.cursor.high_watermark, e); const resolved = setRuntimeErrorStatus(row.fingerprint, 'resolved', e);
    expect(resolved.resolutions).toHaveLength(1); expect(resolved.cursor.high_watermark).toBeGreaterThan(before.cursor.high_watermark);
  });
  it('rejects hostile unknown code, noncanonical timestamp, duplicated sequence and invalid chronology', () => {
    const base = { schema: 'caveat.runtime_errors.v1', next_sequence: 3, acknowledged_through: 0, records: [{ product: 'caveat', product_version: '0.16.2', component: 'database', error_code: 'CAVEAT.DATABASE_OPEN_FAILED', message_template: 'Caveat database open failed', severity: 'high', fingerprint: '0'.repeat(64), count: 1, first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:00:00Z', state_schema_version: '1.0', os: 'darwin', arch: 'arm64', status: 'open', resolved_at: null, reason_code: null, sequence: 1 }] };
    expect(() => runtimeErrorsInternal.validate(base)).toThrow();
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); expect(() => recordRuntimeError('CAVEAT.NOPE' as any, { env: env(root, true) })).toThrow();
  });
  it('projects unavailable store diagnostics without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true); const path = runtimeErrorsStatePath(e); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{bad');
    expect(runtimeErrorsDiagnostics({ env: e })).toMatchObject({ collection: 'enabled', status: 'unavailable', total_count: 0 });
  });
  it('keeps unacknowledged/open records during retention compact', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true); const options = { env: e, version: '0.16.2', now: '2020-01-01T00:00:00.000Z' };
    recordRuntimeError(definition, options); const row = runtimeErrorsSnapshot(0, 256, options).runtime_errors[0]!; setRuntimeErrorStatus(row.fingerprint, 'resolved', options); compactRuntimeErrors({ ...options, now: '2026-01-01T00:00:00.000Z' }); expect(runtimeErrorsSnapshot(0, 256, options).resolutions).toHaveLength(1);
  });
  it('keeps a newly resolved record for 30 days even when its last_seen is old', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true); const initial = { env: e, version: '0.16.2', now: '2020-01-01T00:00:00.000Z' };
    recordRuntimeError(definition, initial); const row = runtimeErrorsSnapshot(0, 256, initial).runtime_errors[0]!;
    const resolved = setRuntimeErrorStatus(row.fingerprint, 'resolved', { ...initial, now: '2026-01-15T00:00:00.000Z' });
    acknowledgeRuntimeErrors(resolved.cursor.high_watermark, initial);
    compactRuntimeErrors({ ...initial, now: '2026-02-13T23:59:59.999Z' });
    expect(runtimeErrorsSnapshot(0, 256, initial).resolutions).toHaveLength(1);
  });
  it('does not advance sequence for resolve/reopen requests already in that state', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true); const options = { env: e, version: '0.16.2' };
    recordRuntimeError(definition, options); const open = runtimeErrorsSnapshot(0, 256, options); const fingerprint = open.runtime_errors[0]!.fingerprint;
    expect(setRuntimeErrorStatus(fingerprint, 'open', options).cursor.high_watermark).toBe(open.cursor.high_watermark);
    const resolved = setRuntimeErrorStatus(fingerprint, 'resolved', options);
    expect(setRuntimeErrorStatus(fingerprint, 'resolved', options).cursor.high_watermark).toBe(resolved.cursor.high_watermark);
    const reopened = setRuntimeErrorStatus(fingerprint, 'open', options);
    expect(setRuntimeErrorStatus(fingerprint, 'open', options).cursor.high_watermark).toBe(reopened.cursor.high_watermark);
  });
  it('rejects future cursor for both disabled and enabled stores', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const disabled = env(root, false);
    expect(() => runtimeErrorsSnapshot(1, 1, disabled)).toThrow('invalid_cursor');
    const enabled = env(root, true); expect(() => runtimeErrorsSnapshot(1, 1, enabled)).toThrow('invalid_cursor');
  });
  it('rejects POSIX store, lock, and directory mode drift plus symlinks', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true); const options = { env: e, version: '0.16.2' }; recordRuntimeError(definition, options); const path = runtimeErrorsStatePath(e); const dir = join(root, 'state', 'caveat'); const lock = `${path}.lock.sqlite`;
    chmodSync(path, 0o644); expect(() => runtimeErrorsSnapshot(0, 1, options)).toThrow('store_unsafe');
    chmodSync(path, 0o600); chmodSync(lock, 0o644); expect(() => recordRuntimeError(definition, options)).toThrow('store_unsafe');
    chmodSync(lock, 0o600); chmodSync(dir, 0o755); expect(() => recordRuntimeError(definition, options)).toThrow('store_unsafe');
    chmodSync(dir, 0o700); const target = `${path}.target`; renameSync(path, target); symlinkSync(target, path); expect(() => runtimeErrorsSnapshot(0, 1, options)).toThrow('store_unsafe');
  });
  it('runs ACL apply and verify for Windows directory, store and lock through seam', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true); const calls: Array<[string, boolean, boolean]> = []; recordRuntimeError(definition, { env: e, version: '0.16.2', isWindows: () => true, aclRunner: (path, directory, apply) => calls.push([path, directory, apply]) });
    expect(calls.some(([, directory]) => directory)).toBe(true); expect(calls.filter(([, , apply]) => apply)).not.toHaveLength(0); expect(calls.filter(([, , apply]) => !apply)).not.toHaveLength(0);
  });
  it('fails closed when the Windows ACL seam cannot apply or verify', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true);
    expect(() => recordRuntimeError(definition, { env: e, version: '0.16.2', isWindows: () => true, aclRunner: () => { throw Error('acl failed'); } })).toThrow('store_unsafe');
    expect(existsSync(runtimeErrorsStatePath(e))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('serializes 20 truly concurrent child recorders without corrupting JSON', { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true);
    const children = Array.from({ length: 20 }, () => child([], e));
    const exits = await Promise.all(children.map(childExit));
    expect(exits.every((result) => result.code === 0 && result.signal === null)).toBe(true);
    const snapshot = runtimeErrorsSnapshot(0, 256, { env: e, version: '0.16.2' }); expect(snapshot.runtime_errors[0]?.occurrence_count).toBe(20); expect(() => JSON.parse(readFileSync(runtimeErrorsStatePath(e), 'utf8'))).not.toThrow();
  });
  it('recovers after the OS releases a SIGKILLed SQLite BEGIN IMMEDIATE holder', { timeout: 30_000 }, async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'caveat-runtime-')); const e = env(root, true); recordRuntimeError(definition, { env: e, version: '0.16.2' });
    const lock = `${runtimeErrorsStatePath(e)}.lock.sqlite`; const holder = child(['hold-lock', lock], e);
    await new Promise<void>((resolve, reject) => { holder.stdout.once('data', (value) => String(value).includes('READY') ? resolve() : reject(Error('lock holder did not become ready'))); holder.once('error', reject); });
    holder.kill('SIGKILL'); const exited = await childExit(holder); expect(exited.signal).toBe('SIGKILL');
    expect(recordRuntimeError(definition, { env: e, version: '0.16.2' }).status).toBe('recorded');
  });
});
