import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { Logger } from '@caveat/core';
import { harnessEntries } from '../src/harnessEntries.js';
import { installClaudeIntegration } from '../src/claudeInstall.js';
import { installCodexHooks } from '../src/codexHookInstall.js';
import { installCursorHooks } from '../src/cursorInstall.js';
import { installMcpClient } from '../src/mcpInstall.js';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
type HookItem = { command: string; type?: string; timeout?: number; async?: boolean; statusMessage?: null };
type HookGroup = { matcher?: string; hooks: HookItem[] };
type NativeHooks = {
  claude: Record<string, HookGroup[]>;
  codex: Record<string, HookGroup[]>;
  cursor: Record<string, HookItem[]>;
};

describe('harnessEntries', () => {
  let root: string;
  let userHome: string;
  let cliScriptPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'caveat-harness-entries-'));
    userHome = join(root, 'home');
    mkdirSync(userHome, { recursive: true });
    cliScriptPath = join(root, 'managed', 'caveat.js');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('matches fresh native installer output for each supported harness', () => {
    const exported = harnessEntries(cliScriptPath, userHome);
    const claudeDir = join(root, 'claude');
    const claudeMcpPath = join(root, 'claude-mcp.json');
    installClaudeIntegration({
      claudeDir,
      mcpConfigPath: claudeMcpPath,
      cliScriptPath,
      nodePath: 'node',
      dryRun: false,
      logger,
    });

    const codexHome = join(root, 'codex');
    mkdirSync(codexHome);
    installCodexHooks({ codexHome, cliScriptPath, nodePath: 'node', dryRun: false, logger });
    const codexMcpPath = join(codexHome, 'config.toml');
    installMcpClient({ client: 'codex', configPath: codexMcpPath, cliScriptPath, nodePath: 'node', dryRun: false });

    const grokMcpPath = join(root, 'grok.toml');
    installMcpClient({ client: 'grok', configPath: grokMcpPath, cliScriptPath, nodePath: 'node', dryRun: false });

    const cursorDir = join(root, 'cursor');
    installCursorHooks({ cursorDir, cliScriptPath, nodePath: 'node', dryRun: false, logger });
    const cursorMcpPath = join(root, 'cursor-mcp.json');
    installMcpClient({ client: 'cursor', configPath: cursorMcpPath, cliScriptPath, nodePath: 'node', dryRun: false });

    const claudeSettings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
    const claudeMcp = JSON.parse(readFileSync(claudeMcpPath, 'utf8'));
    const codexHooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'));
    const codexConfig = parse(readFileSync(codexMcpPath, 'utf8'));
    const grokConfig = parse(readFileSync(grokMcpPath, 'utf8'));
    const cursorHooks = JSON.parse(readFileSync(join(cursorDir, 'hooks.json'), 'utf8'));
    const cursorMcp = JSON.parse(readFileSync(cursorMcpPath, 'utf8'));

    expect(Object.keys(exported.mcpServers.caveat).sort()).toEqual(['claude', 'codex', 'cursor', 'grok']);
    expect(exported.mcpServers.caveat).toEqual({
      claude: claudeMcp.mcpServers.caveat,
      codex: codexConfig.mcp_servers.caveat,
      grok: grokConfig.mcp_servers.caveat,
      cursor: cursorMcp.mcpServers.caveat,
    });
    const hooks = exported.hooks as NativeHooks;
    expect(hooks).toEqual({
      claude: claudeSettings.hooks,
      codex: codexHooks.hooks,
      cursor: cursorHooks.hooks,
    });
    expect(exported.settings).toEqual({ codex: { 'features.hooks': codexConfig.features.hooks } });
    expect(hooks).not.toHaveProperty('grok');
    expect(hooks).not.toHaveProperty('gemini');
    expect(hooks.cursor).not.toHaveProperty('permissions');
    for (const event of Object.values(hooks.cursor)) {
      expect(event).toHaveLength(1);
      expect(event[0]).toHaveProperty('command');
      expect(event[0]).toHaveProperty('timeout', 10);
      expect(event[0]).not.toHaveProperty('type');
    }
  });

  it('selects only requested harnesses, deduplicates deterministically, and rejects unsupported names', () => {
    const selected = harnessEntries(cliScriptPath, userHome, ['codex', 'grok']);
    const repeated = harnessEntries(cliScriptPath, userHome, ['codex', 'grok', 'codex']);

    expect(selected).toEqual(repeated);
    expect(Object.keys(selected.mcpServers.caveat)).toEqual(['codex', 'grok']);
    expect(Object.keys(selected.hooks)).toEqual(['codex']);
    expect(selected.hooks.codex).toHaveProperty('UserPromptSubmit');
    expect(selected.hooks.codex).toHaveProperty('PostToolUse');
    expect(selected.hooks.codex).toHaveProperty('Stop');
    expect(selected.settings).toEqual({ codex: { 'features.hooks': true } });
    expect(() => harnessEntries(cliScriptPath, userHome, ['gemini'])).toThrow('unsupported harness: gemini');
  });

  it('renders the PowerShell call prefix only for Codex on Windows', () => {
    const windows = harnessEntries(cliScriptPath, userHome, ['claude', 'codex', 'cursor'], 'win32');
    const posix = harnessEntries(cliScriptPath, userHome, ['claude', 'codex', 'cursor'], 'linux');
    const windowsHooks = windows.hooks as NativeHooks;
    const posixHooks = posix.hooks as NativeHooks;
    const command = (entry: { command: string }) => entry.command;

    const winCodex = command(windowsHooks.codex.UserPromptSubmit[0]!.hooks[0]!);
    const posixCodex = command(posixHooks.codex.UserPromptSubmit[0]!.hooks[0]!);
    const winClaude = command(windowsHooks.claude.UserPromptSubmit[0]!.hooks[0]!);
    const winCursor = command(windowsHooks.cursor.beforeSubmitPrompt[0]!);
    expect(winCodex.startsWith('& ')).toBe(true);
    expect(posixCodex.startsWith('& ')).toBe(false);
    expect(winClaude.startsWith('& ')).toBe(false);
    expect(winCursor.startsWith('& ')).toBe(false);
    expect(Object.keys(windows.mcpServers.caveat)).toEqual(['claude', 'codex', 'cursor']);
  });
});
