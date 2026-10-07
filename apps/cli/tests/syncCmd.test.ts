import { describe, expect, it, vi, afterEach } from 'vitest';

const core = vi.hoisted(() => ({
  syncOwn: vi.fn(),
  initOwnSync: vi.fn(),
  observeRuntimeError: vi.fn(),
}));

vi.mock('@caveat/core', async (original) => ({ ...await original<typeof import('@caveat/core')>(), ...core }));

import { SyncError, SyncRemoteError, SyncRecoveryError } from '@caveat/core';
import { runSync } from '../src/commands/sync.js';
import type { CliContext } from '../src/context.js';

const messages: string[] = [];
const ctx = {
  caveatHome: '/tmp/caveat-home',
  paths: { knowledgeRepo: '/tmp/caveat-home/own' },
  logger: {
    info: (message: string) => messages.push(`info:${message}`),
    warn: () => {},
    error: (message: string) => messages.push(`error:${message}`),
  },
} as unknown as CliContext;

afterEach(() => {
  core.syncOwn.mockReset();
  core.initOwnSync.mockReset();
  core.observeRuntimeError.mockReset();
  messages.length = 0;
  process.exitCode = undefined;
});

describe('caveat sync command', () => {
  it('keeps cancellation visible without creating a repair report', async () => {
    await runSync(ctx, { init: true, dryRun: false, trustRemotePrivate: false, yes: false }, {
      ghRunner: (args) => args[0] === 'repo' && args[1] === 'view'
        ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: 'alice', stderr: '' },
      isTty: () => true, confirm: () => false,
    });
    expect(process.exitCode).toBe(1);
    expect(messages.join('\n')).toContain('cancelled');
    expect(core.initOwnSync).not.toHaveBeenCalled();
    expect(core.observeRuntimeError).not.toHaveBeenCalled();
  });

  it.each([
    new SyncError('REMOTE_VISIBILITY_INDETERMINATE', 'privacy probe failed'),
    new SyncError('SYNC_CONFLICT', 'rebase was aborted'),
    new SyncRemoteError('push', Error('connection interrupted')),
  ])('surfaces a handled sync failure without an app repair record: %s', async (error) => {
    core.syncOwn.mockRejectedValue(error);
    await runSync(ctx, { dryRun: false, trustRemotePrivate: false, yes: false });
    expect(process.exitCode).toBe(1);
    expect(messages.join('\n')).toContain(error.message);
    expect(core.observeRuntimeError).not.toHaveBeenCalled();
  });

  it.each([
    [new SyncRecoveryError(Error('abort failed')), 'recovery_failed'],
    [Error('unexpected local failure'), 'operation_failed'],
  ] as const)('reports actual operation/recovery failures with impact: %s', async (error, impact) => {
    core.syncOwn.mockRejectedValue(error);
    await runSync(ctx, { dryRun: false, trustRemotePrivate: false, yes: false });
    expect(process.exitCode).toBe(1);
    expect(core.observeRuntimeError).toHaveBeenCalledWith('CAVEAT.SYNC_FAILED', expect.objectContaining({ impact }));
  });

  it('uses --repo without invoking gh', async () => {
    core.initOwnSync.mockResolvedValue({ message: 'initialized' });
    const runner = vi.fn();
    await runSync(ctx, {
      init: true, repo: 'https://example.test/private.git', dryRun: false,
      trustRemotePrivate: false, yes: false,
    }, { ghRunner: runner });
    expect(runner).not.toHaveBeenCalled();
    expect(core.initOwnSync).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.test/private.git' }));
  });

  it('guides manual setup when gh is unavailable', async () => {
    await runSync(ctx, {
      init: true, dryRun: false, trustRemotePrivate: false, yes: false,
    }, { ghRunner: () => ({ status: null, stdout: '', stderr: '' }) });
    expect(messages.join('\n')).toMatch(/Caveat-Private/);
    expect(core.initOwnSync).not.toHaveBeenCalled();
  });

  it('guides gh authentication when login lookup fails', async () => {
    await runSync(ctx, {
      init: true, dryRun: false, trustRemotePrivate: false, yes: false,
    }, {
      ghRunner: (args) => args[0] === '--version'
        ? { status: 0, stdout: 'gh', stderr: '' }
        : { status: 1, stdout: '', stderr: 'not logged in' },
    });
    expect(messages.join('\n')).toMatch(/gh auth login/);
  });

  it('creates the conventional private repo after one confirmation', async () => {
    core.initOwnSync.mockResolvedValue({ message: 'initialized' });
    const runner = vi.fn((args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'gh', stderr: '' };
      if (args[0] === 'api') return { status: 0, stdout: 'alice\n', stderr: '' };
      if (args[0] === 'repo' && args[1] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const confirm = vi.fn(() => true);
    await runSync(ctx, {
      init: true, dryRun: false, trustRemotePrivate: false, yes: false,
    }, { ghRunner: runner, isTty: () => true, confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(['auth', 'setup-git']);
    expect(runner).toHaveBeenCalledWith(['repo', 'create', 'Caveat-Private', '--private']);
    expect(core.initOwnSync).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://github.com/alice/Caveat-Private.git' }));
  });

  it('requires --yes for non-interactive conventional repo creation', async () => {
    const runner = (args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'gh', stderr: '' };
      if (args[0] === 'api') return { status: 0, stdout: 'alice', stderr: '' };
      if (args[0] === 'auth' && args[1] === 'setup-git') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'not found' };
    };
    await runSync(ctx, {
      init: true, dryRun: false, trustRemotePrivate: false, yes: false,
    }, { ghRunner: runner, isTty: () => false });
    expect(messages.join('\n')).toMatch(/--yes/);
  });

  it('passes dry-run through and reports its result without error', async () => {
    core.syncOwn.mockResolvedValue({
      dryRun: true, changedFiles: 2, pushUrls: ['https://example.test/p.git'],
      probe: { kind: 'denied', status: 404 }, branch: 'main', pulled: false,
    });
    await runSync(ctx, {
      dryRun: true, trustRemotePrivate: false, yes: false,
    });
    expect(core.syncOwn).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(core.initOwnSync).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
    expect(messages.join('\n')).toMatch(/\[dry-run\]/);
  });
});
