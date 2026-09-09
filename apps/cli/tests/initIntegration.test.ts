import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import type { Logger } from '@caveat/core';
import { buildContext } from '../src/context.js';
import { runInit } from '../src/commands/init.js';

process.env.GIT_AUTHOR_NAME = 'caveat init test';
process.env.GIT_AUTHOR_EMAIL = 'caveat-init@example.invalid';
process.env.GIT_COMMITTER_NAME = 'caveat init test';
process.env.GIT_COMMITTER_EMAIL = 'caveat-init@example.invalid';

interface Fixture {
  root: string;
  userHome: string;
  caveatHome: string;
  messages: string[];
  logger: Logger;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'caveat-init-integration-'));
  const userHome = join(root, 'home');
  const caveatHome = join(root, 'caveat-home');
  const messages: string[] = [];
  mkdirSync(userHome, { recursive: true });
  mkdirSync(caveatHome, { recursive: true });
  return {
    root,
    userHome,
    caveatHome,
    messages,
    logger: {
      info: (message) => messages.push(`info:${message}`),
      warn: (message) => messages.push(`warn:${message}`),
      error: (message) => messages.push(`error:${message}`),
    },
  };
}

describe('caveat init integrated setup', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
    for (const key of ['CODEX_HOME', 'GROK_HOME', 'CURSOR_HOME', 'CLAUDE_CONFIG_DIR']) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('keeps new setup choices off and emits no nudges outside a TTY', async () => {
    const confirm = vi.fn(() => true);
    const ghRunner = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });

    await runInit(
      ctx,
      { skipClaude: true, dryRun: false },
      { isTty: () => false, confirm, ghRunner, codexAvailable: () => false },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(ghRunner).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.paths.knowledgeRepo, '.git'))).toBe(false);
    expect(existsSync(join(fx.userHome, '.codex'))).toBe(false);
    expect(fx.messages.join('\n')).not.toMatch(/今すぐ設定|封緘ミラー/);
  });

  it('nudges once per unspecified setup choice in a TTY and defaults through confirmation', async () => {
    const confirm = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const ghRunner = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });

    await runInit(
      ctx,
      { skipClaude: true, dryRun: true, skipCodexHook: true },
      { isTty: () => true, confirm, ghRunner, codexAvailable: () => false },
    );

    expect(confirm.mock.calls.map(([question]) => question)).toEqual([
      'private 同期を今すぐ設定する？ [y/N]',
      '公開 repo（封緘ミラー）も設定する？ [y/N]',
    ]);
    expect(ghRunner).not.toHaveBeenCalled();
    expect(fx.messages.join('\n')).toContain('[dry-run] would initialize private sync');
    expect(fx.messages.join('\n')).not.toContain('would configure publish target');
  });

  it('--sync --yesはTTYでも公開ミラーの質問を挟まず既存設定を保持する', async () => {
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });
    const confirm = vi.fn(() => false);
    await runInit(ctx, { skipClaude: true, dryRun: true, sync: true, yes: true }, {
      isTty: () => true, confirm, codexAvailable: () => false,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fx.messages.join('\n')).not.toContain('would configure publish target');
  });

  it('初回dry-runは設定とscaffoldを作らない', async () => {
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });
    await runInit(ctx, { skipClaude: true, dryRun: true, sync: true, yes: true }, {
      isTty: () => false, codexAvailable: () => false,
    });
    expect(existsSync(ctx.userConfigPath)).toBe(false);
    expect(existsSync(ctx.paths.knowledgeRepo)).toBe(false);
    expect(existsSync(ctx.paths.dbPath)).toBe(false);
  });

  it('initializes an explicit file URL without gh and syncs it on re-init', async () => {
    const remote = join(fx.root, 'private.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
    const remoteUrl = pathToFileURL(remote).href;
    const ghRunner = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const confirm = vi.fn(() => true);
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });
    const opts = {
      skipClaude: true,
      dryRun: false,
      sync: remoteUrl,
      publishTarget: 'https://github.com/example/Caveat-Public.git',
      skipCodexHook: true,
    };
    const dependencies = {
      isTty: () => true,
      confirm,
      ghRunner,
      codexAvailable: () => false,
    };

    await runInit(ctx, opts, dependencies);
    await runInit(ctx, opts, dependencies);

    expect(ghRunner).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.paths.knowledgeRepo, '.git'))).toBe(true);
    expect(fx.messages.join('\n')).toContain('synced existing private remote:');
    expect(fx.messages.join('\n')).toContain(`private remote: ${remoteUrl}`);
    expect(fx.messages.join('\n')).toContain('publish target: https://github.com/example/Caveat-Public.git');
    expect(fx.messages.join('\n')).toContain('community sources: 0');
    expect(fx.messages.join('\n')).toContain('codex hook: skipped');
  });

  it('fails loud when explicitly requested private sync cannot be initialized', async () => {
    const missingRemote = pathToFileURL(join(fx.root, 'missing-private.git')).href;
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });

    await expect(runInit(
      ctx,
      {
        skipClaude: true,
        dryRun: false,
        sync: missingRemote,
        skipCodexHook: true,
        skipCursorHook: true,
      },
      { isTty: () => false, codexAvailable: () => false },
    )).rejects.toThrow(/private sync setup failed/u);
  });

  it('reports explicit Codex feature refusal and never overwrites it', async () => {
    const codexHome = join(fx.userHome, '.codex');
    const configPath = join(codexHome, 'config.toml');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, '[features]\ncodex_hooks = false\n', 'utf-8');
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });

    await runInit(
      ctx,
      { skipClaude: true, dryRun: false },
      { isTty: () => false, codexAvailable: () => true },
    );

    expect(parse(readFileSync(configPath, 'utf-8')).features).toEqual({ codex_hooks: false });
    expect(parse(readFileSync(configPath, 'utf-8')).mcp_servers).toHaveProperty('caveat');
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
    expect(fx.messages.join('\n')).toMatch(/preserving explicit consent/);
    expect(fx.messages.join('\n')).toMatch(/Set `hooks = true`/);
    expect(fx.messages.join('\n')).toContain('codex hook: skipped');
  });

  it('init一回で独自HOMEのCodex・Grok・Cursorに登録し再実行できる', async () => {
    const codexHome = join(fx.root, 'codex');
    const grokHome = join(fx.root, 'grok');
    const cursorHome = join(fx.root, 'cursor');
    for (const dir of [codexHome, grokHome, cursorHome]) mkdirSync(dir);
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });
    const opts = { skipClaude: true, skipCodexHook: true, skipCursorHook: true, dryRun: false };
    const dependencies = { isTty: () => false, codexAvailable: () => true, env: {
      CODEX_HOME: codexHome, GROK_HOME: grokHome, CURSOR_HOME: cursorHome,
    } };
    await runInit(ctx, opts, dependencies);
    await runInit(ctx, opts, dependencies);
    for (const dir of [codexHome, grokHome]) {
      expect(parse(readFileSync(join(dir, 'config.toml'), 'utf8')).mcp_servers).toHaveProperty('caveat');
    }
    expect(JSON.parse(readFileSync(join(cursorHome, 'mcp.json'), 'utf8')).mcpServers.caveat.args.at(-1)).toBe('mcp-server');
    expect(existsSync(join(fx.userHome, '.codex'))).toBe(false);
    for (const client of ['codex', 'grok', 'cursor']) expect(fx.messages).toContain(`info:${client} MCP: unchanged`);
  });

  it('Codex CLIがPATHになくても既存のCodex設定先へMCPを登録する', async () => {
    const codexHome = join(fx.userHome, '.codex');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'config.toml'), '[features]\nhooks = false\n');
    const ctx = buildContext(fx.logger, { userHome: fx.userHome, caveatHome: fx.caveatHome });
    await runInit(ctx, { skipClaude: true, dryRun: false }, { isTty: () => false, codexAvailable: () => false });
    const config = parse(readFileSync(join(codexHome, 'config.toml'), 'utf8'));
    expect(config.mcp_servers).toHaveProperty('caveat');
    expect(config.features).toEqual({ hooks: false });
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
  });
});
