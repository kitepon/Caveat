import { expect, it, vi } from 'vitest';
vi.mock('@caveat/core', async importOriginal => ({
  ...await importOriginal<typeof import('@caveat/core')>(),
  managedInstallerLockStatus: vi.fn(() => ({ status: 'absent' })),
  managedShellStatusCurrent: vi.fn(async () => ({ status: 'unknown', native: {}, deployment: null })),
  verifyManagedDeployment: vi.fn(() => ({ pointer: { release: '1.0.0-reviewed' }, manifest: { version: '1.0.0' }, launcher: '/managed/entry/caveat.mjs' })),
  readMcpSyncState: vi.fn(() => null),
  staleMcpServers: vi.fn(async () => ({ status: 'observed', staleServers: [{ pid: 42, parentApp: 'Codex', instruction: 'Reopen that client' }] })),
}));
import { deploymentStatus } from '../src/commands/deployment.js';
it('reports verified A payload independently from an unknown native B shell', async () => {
  expect(await deploymentStatus()).toMatchObject({ status: 'ready', payloadVerified: true, version: '1.0.0', shell: { status: 'unknown' } });
});

it('includes product-owned old-client guidance without restarting any client', async () => {
  expect(await deploymentStatus()).toMatchObject({ clients: { staleServers: [{ pid: 42, parentApp: 'Codex', instruction: expect.stringContaining('Reopen') }] } });
});
