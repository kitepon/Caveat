import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookDiagnosticKind, localHookDiagnostics, observeHookDiagnostic } from '../src/hookDiagnostics.js';
import { recordRuntimeError, runtimeErrorsSnapshot } from '../src/runtimeErrors.js';

const code = 'CAVEAT.CLAUDE_HOOK_FAILED';
function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'caveat-hook-details-'));
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ runtimeErrors: enabled }));
  return { root, options: { configPath, storePath: join(root, 'state', 'runtime-errors.json'), version: '0.20.2', aclRunner: () => {} }, path: join(root, 'state', 'hook-diagnostics.json') };
}

describe('local hook diagnostics', () => {
  it('persists fixed metadata while leaving the receiver snapshot unchanged', () => {
    const { root, options, path } = fixture();
    try {
      const error = Object.assign(new Error('private prompt /home/private sk-secret'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
      recordRuntimeError(code, options);
      const before = runtimeErrorsSnapshot(0, 256, options);
      observeHookDiagnostic(code, 'markHit error', error, { ...options, now: '2026-10-06T05:46:49.595Z' });
      expect(localHookDiagnostics(options).records).toEqual([{ at: '2026-10-06T05:46:49.595Z', version: '0.20.2', error_code: code, phase: 'markHit error', kind: 'sqlite_busy' }]);
      expect(runtimeErrorsSnapshot(0, 256, options)).toEqual(before);
      expect(readFileSync(path, 'utf8')).not.toMatch(/private|sk-secret|\/home/);
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('creates no diagnostic state when collection is disabled', () => {
    const { root, options, path } = fixture(false);
    try {
      observeHookDiagnostic(code, 'json parse error', new SyntaxError('private prompt'), options);
      expect(existsSync(path)).toBe(false);
      expect(localHookDiagnostics(options)).toMatchObject({ status: 'disabled', records: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps only the latest 64 failures and rejects an unexpected field on read', () => {
    const { root, options, path } = fixture();
    try {
      for (let n = 0; n < 65; n++) observeHookDiagnostic(code, 'search error', new Error('private'), { ...options, now: new Date(n * 1000).toISOString() });
      const output = localHookDiagnostics(options);
      expect(output.records).toHaveLength(64);
      expect(output.records[0]?.at).toBe('1970-01-01T00:00:01.000Z');
      const stored = JSON.parse(readFileSync(path, 'utf8'));
      stored.records[0].message = 'private';
      writeFileSync(path, JSON.stringify(stored));
      expect(localHookDiagnostics(options)).toMatchObject({ status: 'unavailable', records: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('classifies numeric SQLite codes and errno without retaining exception text', () => {
    expect(hookDiagnosticKind(new SyntaxError('prompt fragment'))).toBe('invalid_json');
    expect(hookDiagnosticKind({ code: 'ERR_SQLITE_ERROR', errcode: 517 })).toBe('sqlite_busy');
    expect(hookDiagnosticKind({ code: 'ERR_SQLITE_ERROR', errcode: 8 })).toBe('sqlite_readonly');
    expect(hookDiagnosticKind({ code: 'ERR_SQLITE_ERROR', errcode: 26 })).toBe('sqlite_corrupt');
    expect(hookDiagnosticKind({ code: 'EACCES', path: '/private' })).toBe('permission_denied');
    expect(hookDiagnosticKind({ code: 'ENOENT', path: '/private' })).toBe('missing_path');
    expect(hookDiagnosticKind('private prompt')).toBe('other');
  });
});
