import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/context.js';
import { autosyncStatus, runAutosync } from '../src/commands/autosync.js';

const roots: string[] = [];
const silent = { info: () => {}, warn: () => {}, error: () => {} };
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caveat-autosync-cli-')); roots.push(root);
  const userHome = join(root, 'user'); mkdirSync(userHome);
  return buildContext(silent, { userHome, caveatHome: join(root, 'caveat') });
}

describe('autosync JSON and completion status', () => {
  it('emits a single JSON result and exit 2 when reception is explicitly disabled', async () => {
    const ctx = fixture(); vi.stubEnv('CAVEAT_AUTO_SYNC', 'off');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runAutosync(ctx);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ schema: 'caveat.periodic_sync.v1', status: 'skipped', reason: 'disabled' });
    expect(process.exitCode).toBe(2);
    output.mockClear(); autosyncStatus(ctx);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ state: { last_result: { reason: 'disabled' }, last_attempt: null, last_success_at: null } });
  });

  it('returns JSON failure and exit 1 if state cannot be stored', async () => {
    const ctx = fixture(); mkdirSync(ctx.caveatHome, { recursive: true });
    writeFileSync(join(ctx.caveatHome, 'sync'), 'a fixture file blocks the state directory');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runAutosync(ctx);
    const result = JSON.parse(String(output.mock.calls[0]![0]));
    expect(result).toMatchObject({ status: 'failed', reason: 'state_unavailable' });
    expect(JSON.stringify(result)).not.toContain(ctx.caveatHome); expect(process.exitCode).toBe(1);
  });
});

it('schedule dry-run uses the shipped CLI and explicit homes without registration or state writes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { existsSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const ctx = fixture();
  writeFileSync(ctx.userConfigPath, JSON.stringify({ knowledgeRepo: 'knowledge-fixture' }));
  const before = readFileSync(ctx.userConfigPath, 'utf8');
  const cli = fileURLToPath(new URL('../dist/caveat.js', import.meta.url));
  const child = spawnSync(process.execPath, [cli, 'autosync', 'schedule', 'install', '--json', '--dry-run', '--caveat-home', ctx.caveatHome, '--user-home', ctx.userHome], { encoding: 'utf8', timeout: 10_000 });
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result).toMatchObject({ schema: 'caveat.sync_schedule_result.v1', status: 'planned', reason: 'install' });
  expect(result.definition.argv).toEqual([process.execPath, cli, 'autosync', 'run', '--json', '--caveat-home', ctx.caveatHome, '--user-home', ctx.userHome]);
  expect(existsSync(ctx.caveatHome)).toBe(false); expect(readFileSync(ctx.userConfigPath, 'utf8')).toBe(before);
  // Generated native argv must be accepted by the actual shipped CLI.
  const cycle = spawnSync(result.definition.argv[0], result.definition.argv.slice(1), { encoding: 'utf8', timeout: 10_000, env: { ...process.env, CAVEAT_AUTO_SYNC: 'off' } });
  expect(cycle.status).toBe(2); expect(JSON.parse(cycle.stdout)).toMatchObject({ status: 'skipped', reason: 'disabled' });
  expect(readFileSync(ctx.userConfigPath, 'utf8')).toBe(before);
});
