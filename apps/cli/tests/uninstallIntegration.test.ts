import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/context.js';
import { runInit, runUninstall } from '../src/commands/init.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: null, error: Object.assign(new Error('CLIなし'), { code: 'ENOENT' }) })),
}));

describe('独自CLAUDE_CONFIG_DIRの導入と解除', () => {
  const roots: string[] = [];
  afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('Claude CLIがなくても同じ設定先からCaveatだけを解除できる', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-uninstall-')); roots.push(root);
    const home = join(root, 'home'); const claudeDir = join(root, 'claude-custom');
    mkdirSync(home); mkdirSync(claudeDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
    const other = { mcpServers: { other: { command: 'other' } }, preferences: { keep: true } };
    writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify(other));
    const untouched = JSON.stringify({ mcpServers: { untouched: { command: 'untouched' } } });
    writeFileSync(join(home, '.claude.json'), untouched);
    const ctx = buildContext({ info() {}, warn() {}, error() {} }, { userHome: home, caveatHome: join(root, 'caveat') });
    await runInit(ctx, { skipClaude: false, dryRun: false, skipCodexHook: true, skipCursorHook: true }, {
      isTty: () => false, codexAvailable: () => false, env: { CLAUDE_CONFIG_DIR: claudeDir },
    });
    expect(JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8')).mcpServers).toHaveProperty('caveat');
    runUninstall(ctx, { dryRun: false });
    expect(JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8'))).toEqual(other);
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).not.toContain('caveat');
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(untouched);
    runUninstall(ctx, { dryRun: false });
    expect(JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8'))).toEqual(other);
  });
});
