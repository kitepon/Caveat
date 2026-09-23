import { describe, expect, it, vi, afterEach } from 'vitest';

const core = vi.hoisted(() => ({
  publishOwn: vi.fn(),
  writeUserConfigPatch: vi.fn(),
  PublishScanError: class PublishScanError extends Error {
    findings: unknown[];
    constructor(findings: unknown[]) {
      super('scan failed');
      this.findings = findings;
    }
  },
}));
vi.mock('@caveat/core', () => core);

import { runPublish } from '../src/commands/publish.js';
import type { CliContext } from '../src/context.js';

const messages: string[] = [];
const ctx = {
  caveatHome: '/tmp/caveat-home',
  userConfigPath: '/tmp/caveat-home/.caveatrc.json',
  config: { knowledgeRepo: 'own', semverKeys: [], publishTarget: null },
  paths: { knowledgeRepo: '/tmp/caveat-home/own', entriesDir: '/tmp/caveat-home/own/entries', publishMirrorDir: '/tmp/caveat-home/publish/mirror' },
  logger: {
    info: (m: string) => messages.push(`info:${m}`),
    warn: () => {},
    error: (m: string) => messages.push(`error:${m}`),
  },
} as unknown as CliContext;

afterEach(() => {
  core.publishOwn.mockReset();
  core.writeUserConfigPatch.mockReset();
  messages.length = 0;
  process.exitCode = undefined;
});

describe('caveat publish command', () => {
  it('--init validates and persists the publish target, accepting https and scp', async () => {
    core.publishOwn.mockResolvedValue({ fileCount: 0, changed: false, dryRun: false });
    await runPublish(ctx, { init: 'https://github.com/alice/Caveat-Public', dryRun: false, yes: false }, { ghRunner: () => ({ status: 0, stdout: '', stderr: '' }) });
    expect(core.writeUserConfigPatch).toHaveBeenCalledWith(ctx.userConfigPath, { publishTarget: 'https://github.com/alice/Caveat-Public' });
    core.writeUserConfigPatch.mockClear();
    await runPublish(ctx, { init: 'git@github.com:alice/Caveat-Public.git', dryRun: false, yes: false });
    expect(core.writeUserConfigPatch).toHaveBeenCalledWith(ctx.userConfigPath, { publishTarget: 'git@github.com:alice/Caveat-Public.git' });
  });

  it('--init rejects a non-GitHub target', async () => {
    await runPublish(ctx, { init: 'https://gitlab.com/a/b', dryRun: false, yes: false });
    expect(messages.join('\n')).toMatch(/invalid publish target/);
    expect(core.publishOwn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('creates the conventional public repo after one confirmation when no target set', async () => {
    core.publishOwn.mockResolvedValue({ fileCount: 3, changed: true, dryRun: false });
    const runner = vi.fn((args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: 'gh', stderr: '' };
      if (args[0] === 'api') return { status: 0, stdout: 'bob\n', stderr: '' };
      if (args[0] === 'repo' && args[1] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const confirm = vi.fn(() => true);
    await runPublish(ctx, { dryRun: false, yes: false }, { ghRunner: runner, isTty: () => true, confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(['repo', 'create', 'Caveat-Public', '--public']);
    expect(core.writeUserConfigPatch).toHaveBeenCalledWith(ctx.userConfigPath, { publishTarget: 'https://github.com/bob/Caveat-Public.git' });
  });

  it('guides manual setup when gh is unavailable', async () => {
    await runPublish(ctx, { dryRun: false, yes: false }, { ghRunner: () => ({ status: null, stdout: '', stderr: '' }) });
    expect(messages.join('\n')).toMatch(/Caveat-Public/);
    expect(core.publishOwn).not.toHaveBeenCalled();
  });

  it('reports a dry-run without error', async () => {
    core.publishOwn.mockResolvedValue({ fileCount: 5, changed: true, dryRun: true });
    await runPublish({ ...ctx, config: { ...ctx.config, publishTarget: 'https://github.com/x/Caveat-Public.git' } } as CliContext, { dryRun: true, yes: false });
    expect(messages.join('\n')).toMatch(/\[dry-run\]/);
    expect(process.exitCode).not.toBe(1);
  });

  it('passes publish scan allow/save options through', async () => {
    core.publishOwn.mockResolvedValue({ fileCount: 1, changed: false, dryRun: false });
    const withTarget = { ...ctx, config: { ...ctx.config, publishTarget: 'https://github.com/x/Caveat-Public.git' } } as CliContext;
    await runPublish(withTarget, { dryRun: false, yes: true, allow: ['a'.repeat(64)], save: true });
    expect(core.publishOwn).toHaveBeenCalledWith(expect.objectContaining({
      allow: ['a'.repeat(64)],
      saveAllow: true,
    }));
  });

  it('prints scan findings with copyable allow lines', async () => {
    const err = new core.PublishScanError([{
      relPath: 'entry.md',
      line: 7,
      rule: 'aws-key',
      excerpt: 'aws AKIA****MNOP',
      matchDigest: 'b'.repeat(64),
    }]);
    core.publishOwn.mockRejectedValue(err);
    const withTarget = { ...ctx, config: { ...ctx.config, publishTarget: 'https://github.com/x/Caveat-Public.git' } } as CliContext;
    await runPublish(withTarget, { dryRun: false, yes: true });
    expect(messages.join('\n')).toContain('entry.md:7 aws-key aws AKIA****MNOP');
    expect(messages.join('\n')).toContain(`--allow ${'b'.repeat(64)}`);
    expect(process.exitCode).toBe(1);
  });
});
