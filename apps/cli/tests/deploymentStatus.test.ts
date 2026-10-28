import { expect, it, vi } from 'vitest';
vi.mock('@caveat/core', async importOriginal => ({
  ...await importOriginal<typeof import('@caveat/core')>(),
  managedInstallerLockStatus: vi.fn(() => ({ status: 'absent' })),
  managedShellStatusCurrent: vi.fn(async () => ({ status: 'unknown', native: {}, deployment: null })),
  verifyManagedDeployment: vi.fn(() => ({ pointer: { release: '1.0.0-reviewed' }, manifest: { version: '1.0.0' }, launcher: '/managed/entry/caveat.mjs' })),
  readMcpSyncState: vi.fn(() => null),
}));
import { deploymentStatus } from '../src/commands/deployment.js';
it('reports verified A payload independently from an unknown native B shell', async () => {
  expect(await deploymentStatus()).toMatchObject({ status: 'ready', payloadVerified: true, version: '1.0.0', shell: { status: 'unknown' } });
});
