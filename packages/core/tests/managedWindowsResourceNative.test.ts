import { describe, expect, it } from 'vitest';
import { decodeWindowsResourceObservation, readWindowsResourceUsers, WINDOWS_RESOURCE_QUERY } from '../src/managedWindowsResourceNative.js';
const sample = { schema: 'caveat.windows_resources.v1', files: 1, regularFiles: 1, directories: 0, stage: 'complete', code: 0, endCode: 0, rebootReasons: 0, observerAdministrator: false,
  users: [{ pid: 42, birth: '2026-01-01T00:00:00.1234567Z', type: 3, service: true, session: 0xffffffff }] };
describe('documented Windows resource-user query', () => {
  it('requires a complete ended session and native PID/birth identities without deriving ownership', () => {
    expect(decodeWindowsResourceObservation(JSON.stringify(sample), 1)).toEqual(sample);
    for (const change of [{ endCode: 5 }, { files: 2 }, { regularFiles: 2 }, { directories: 1 }, { users: [...sample.users, ...sample.users] }, { users: [{ ...sample.users[0], birth: '' }] }, { users: [{ ...sample.users[0], type: 999 }] }]) {
      expect(() => decodeWindowsResourceObservation(JSON.stringify({ ...sample, ...change }), 1)).toThrow();
    }
    expect(WINDOWS_RESOURCE_QUERY).not.toMatch(/RmShutdown|RmRestart|SeDebugPrivilege|AdjustTokenPrivileges|ntdll/i);
  });
  it('keeps native refusal separate from successful empty resource observations', async () => {
    const result = await readWindowsResourceUsers('owned-fixture', ['C:\\protected\\file.js'], () => {}, async () => ({ pid: 42, stdout: JSON.stringify({ ...sample, stage: 'register', code: 5, users: [] }) }));
    expect(result).toMatchObject({ stage: 'register', code: 5 });
  });
});
