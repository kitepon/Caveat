import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runtimeErrorsInternal as state, type RuntimeErrorOptions } from './runtimeErrors.js';

const phases = ['json parse error', 'context error', 'search error', 'markHit error', 'query log error'] as const;
const kinds = ['invalid_json', 'sqlite_busy', 'sqlite_readonly', 'sqlite_corrupt', 'permission_denied', 'missing_path', 'other'] as const;
const codes = ['CAVEAT.CLAUDE_HOOK_FAILED', 'CAVEAT.CODEX_HOOK_FAILED', 'CAVEAT.CURSOR_HOOK_FAILED'] as const;
export type HookDiagnosticPhase = typeof phases[number];
type HookDiagnostic = { at: string; version: string; error_code: typeof codes[number]; phase: HookDiagnosticPhase; kind: typeof kinds[number] };
const SCHEMA = 'caveat.local_hook_diagnostics.v1';
const MAX_DETAILS = 64;

// Never inspect/store exception messages: JSON parse errors can include a
// piece of the prompt, and filesystem errors can include private paths.
export function hookDiagnosticKind(error: unknown): HookDiagnostic['kind'] {
  if (error instanceof SyntaxError) return 'invalid_json';
  if (typeof error !== 'object' || error === null) return 'other';
  const err = error as { code?: unknown; errcode?: unknown };
  if (err.code === 'ERR_SQLITE_ERROR' && Number.isInteger(err.errcode)) {
    const code = (err.errcode as number) & 0xff;
    if (code === 5 || code === 6) return 'sqlite_busy';
    if (code === 8) return 'sqlite_readonly';
    if (code === 11 || code === 26) return 'sqlite_corrupt';
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') return 'permission_denied';
  if (err.code === 'ENOENT') return 'missing_path';
  return 'other';
}

function readDetails(path: string, isWin: boolean, options: RuntimeErrorOptions): HookDiagnostic[] {
  if (!existsSync(path)) return [];
  state.ensureSafeFile(path, isWin, options);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || Object.keys(value).sort().join(',') !== 'records,schema' || value.schema !== SCHEMA
    || !Array.isArray(value.records) || value.records.length > MAX_DETAILS) throw Error('hook_diagnostics_invalid');
  for (const record of value.records) {
    if (!record || Object.keys(record).sort().join(',') !== 'at,error_code,kind,phase,version'
      || !Number.isFinite(Date.parse(record.at)) || new Date(record.at).toISOString() !== record.at
      || !state.validVersion(record.version) || !codes.includes(record.error_code)
      || !phases.includes(record.phase) || !kinds.includes(record.kind)) throw Error('hook_diagnostics_invalid');
  }
  return value.records;
}

export function observeHookDiagnostic(errorCode: typeof codes[number], phase: HookDiagnosticPhase, error: unknown, options: RuntimeErrorOptions = {}): void {
  if (!state.collectionEnabled(options)) return;
  try {
    if (!codes.includes(errorCode) || !phases.includes(phase)) throw Error('hook_diagnostics_invalid');
    const { path: storePath, isWin } = state.optionsFor(options);
    const path = join(dirname(storePath), 'hook-diagnostics.json');
    state.lock(path, isWin, () => {
      const records = readDetails(path, isWin, options);
      const version = options.version ?? '0.0.0';
      if (!state.validVersion(version)) throw Error('hook_diagnostics_invalid');
      records.push({ at: state.now(options), version, error_code: errorCode, phase, kind: hookDiagnosticKind(error) });
      const temporary = join(dirname(path), `.hook-diagnostics-${process.pid}-${randomBytes(6).toString('hex')}`);
      try {
        writeFileSync(temporary, JSON.stringify({ schema: SCHEMA, records: records.slice(-MAX_DETAILS) }) + '\n', { mode: 0o600, flag: 'wx' });
        if (isWin) state.secureWindowsAcl(temporary, options.aclRunner, false, true);
        state.ensureSafeFile(temporary, isWin, options);
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    }, options);
  } catch { try { process.stderr.write('[caveat:hook-diagnostics] unavailable\n'); } catch {} }
}

export function localHookDiagnostics(options: RuntimeErrorOptions = {}) {
  if (!state.collectionEnabled(options)) return { schema: SCHEMA, status: 'disabled', records: [] };
  try {
    const { path: storePath, isWin } = state.optionsFor(options);
    return { schema: SCHEMA, status: 'ready', records: readDetails(join(dirname(storePath), 'hook-diagnostics.json'), isWin, options) };
  } catch { return { schema: SCHEMA, status: 'unavailable', records: [] }; }
}
