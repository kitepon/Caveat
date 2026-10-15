import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageSyncSchedule, nativeScheduleUserId } from '@caveat/core';
import { buildContext } from '../src/context.js';
import { autosyncSchedule } from '../src/commands/autosync.js';

vi.mock('@caveat/core', async importOriginal => ({
  ...await importOriginal<typeof import('@caveat/core')>(),
  nativeScheduleUserId: vi.fn(), manageSyncSchedule: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caveat-schedule-sid-')); roots.push(root);
  return buildContext({ info: () => {}, warn: () => {}, error: () => {} }, { caveatHome: join(root, 'data'), userHome: join(root, 'home') });
}
it('passes the resolved current SID instead of USERDOMAIN to the native manager', () => {
  const sid = 'S-1-5-21-123-456-789-1001'; vi.stubEnv('USERDOMAIN', 'WORKGROUP');
  vi.mocked(nativeScheduleUserId).mockReturnValue(sid);
  vi.mocked(manageSyncSchedule).mockReturnValue({ schema: 'caveat.sync_schedule_result.v1', status: 'planned', reason: 'install' });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  autosyncSchedule(fixture(), 'install', true);
  expect(manageSyncSchedule).toHaveBeenCalledWith('install', expect.objectContaining({ userId: sid, dryRun: true }));
  expect(output).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(0);
});
it('preserves identity failure as JSON and never attempts registration', () => {
  vi.mocked(nativeScheduleUserId).mockImplementation(() => { throw Error('schedule_user_identity_unavailable'); });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  autosyncSchedule(fixture(), 'install');
  expect(manageSyncSchedule).not.toHaveBeenCalled(); expect(output).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ status: 'failed', reason: 'schedule_user_identity_unavailable' });
  expect(process.exitCode).toBe(1);
});
it('does not expose arbitrary identity lookup error text', () => {
  vi.mocked(nativeScheduleUserId).mockImplementation(() => { throw Error('private account/error detail'); });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  autosyncSchedule(fixture(), 'install');
  expect(manageSyncSchedule).not.toHaveBeenCalled();
  const json = String(output.mock.calls[0]![0]); expect(json).not.toContain('private');
  expect(JSON.parse(json)).toMatchObject({ status: 'failed', reason: 'schedule_unavailable' });
});
