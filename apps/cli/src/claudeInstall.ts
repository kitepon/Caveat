import { constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@caveat/core';
import { claudeMcpConfigPath, commandTokens, isCanonicalAsset, quoteCommandPath, writeJsonWithBackup } from './installShared.js';
import { installMcpClient, uninstallMcpClient } from './mcpInstall.js';

export interface ClaudeInstallOptions {
  claudeDir: string;
  mcpConfigPath?: string;
  /** Absolute path to the bundled CLI script (used with process.execPath). */
  cliScriptPath: string;
  /** Absolute path to the `node` binary. */
  nodePath: string;
  dryRun: boolean;
  logger: Logger;
  /** テストなどでMCP設定の変更を省略する。 */
  skipMcpRegistration?: boolean;
}

export interface ClaudeInstallResult {
  mcp: { action: 'registered' | 'skipped' | 'failed'; detail?: string };
  hooks: {
    userPromptSubmit: 'added' | 'unchanged';
    postToolUse: 'added' | 'unchanged';
    postToolUseFailure: 'added' | 'unchanged';
    stop: 'added' | 'unchanged';
  };
  backupPath?: string;
}

const EVENT_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
const EVENT_POST_TOOL_USE = 'PostToolUse';
const EVENT_POST_TOOL_USE_FAILURE = 'PostToolUseFailure';
const EVENT_STOP = 'Stop';

function hookCommand(
  nodePath: string,
  cliScriptPath: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): string {
  return `${quoteCommandPath(nodePath)} ${quoteCommandPath(cliScriptPath)} hook ${event}`;
}

type HookEntry = { hooks: Array<{ type: string; command: string }> };
type HookMap = Record<string, HookEntry[]>;
type Settings = {
  hooks?: HookMap;
  [key: string]: unknown;
};

function upsertHook(
  settings: Settings,
  event: string,
  command: string,
): 'added' | 'unchanged' {
  settings.hooks ??= {};
  const list = (settings.hooks[event] ??= []);
  const subcommand = command.includes('hook user-prompt-submit')
    ? 'user-prompt-submit'
    : command.includes('hook post-tool-use')
      ? 'post-tool-use'
      : command.includes('hook stop')
        ? 'stop'
        : null;
  for (const entry of list) {
    for (const hook of entry.hooks ?? []) {
      if (isSameHookCommand(hook.command, command)) return 'unchanged';
      if (subcommand && isCaveatClaudeHookCommand(hook.command, subcommand)) {
        hook.command = `${envPrefix(hook.command)}${command}`;
        return 'added';
      }
    }
  }
  list.push({ hooks: [{ type: 'command', command }] });
  return 'added';
}

function removeHook(settings: Settings, event: string, command: string): boolean {
  const list = settings.hooks?.[event];
  if (!list) return false;
  const before = list.length;
  const filtered = list.filter(
    (entry) => !entry.hooks?.some((h) => isSameHookCommand(h.command, command)),
  );
  if (filtered.length === before) return false;
  settings.hooks![event] = filtered;
  return true;
}

function findExistingHookCommand(
  settings: Settings,
  event: string,
  command: string,
): string | undefined {
  const list = settings.hooks?.[event];
  if (!list) return undefined;
  for (const entry of list) {
    const found = entry.hooks?.find((h) => isSameHookCommand(h.command, command));
    if (found) return found.command;
  }
  return undefined;
}

function isSameHookCommand(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(` ${expected}`);
}

function envPrefix(command: string): string {
  return command.match(/^((?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+)/)?.[1] ?? '';
}

/** Read-only canonical detector shared by installer and factory diagnostics. */
function isCaveatClaudeHookCommand(
  actual: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): boolean {
  const lower = actual.toLowerCase();
  return lower.includes('caveat') && actual.includes(`hook ${event}`);
}

/** Exact read-only detector used by factory diagnostics; accepts only installer-owned assets. */
export function isCanonicalCaveatClaudeHookCommand(actual: string, event: 'user-prompt-submit' | 'post-tool-use' | 'stop', nodePath: string, cliScriptPath: string): boolean {
  const tokens = commandTokens(actual);
  const [actualNodePath, actualCliScriptPath, subcommand, actualEvent] = tokens ?? [];
  if (tokens?.length !== 4 || actualNodePath === undefined || actualCliScriptPath === undefined || subcommand !== 'hook' || actualEvent !== event) return false;
  // quoting はコマンド内の実パスから再構成した正規形と一致する場合だけ認める（legacy unsafe shape の拒否）。
  // パス同一性は realpath 照合（isCanonicalAsset）が持つ——installer の安定パス（symlink）と
  // 診断側の process.execPath（実体）は文字列一致しないため、期待文字列との完全一致では比較しない。
  if (actual !== hookCommand(actualNodePath, actualCliScriptPath, event)) return false;
  return isCanonicalAsset(actualNodePath, nodePath, constants.X_OK) && isCanonicalAsset(actualCliScriptPath, cliScriptPath, constants.R_OK);
}

/** 製品のstdio実行先を検証し、保持した利用者の追加設定は許容する。 */
export function isCaveatClaudeMcpRegistration(value: unknown, nodePath: string, cliScriptPath: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  return ['args', 'command', 'env', 'type'].every((key) => Object.hasOwn(server, key))
    && server.type === 'stdio' && isCanonicalAsset(server.command, nodePath, constants.X_OK) && Array.isArray(server.args)
    && server.args.length === 3 && server.args[0] === '--disable-warning=ExperimentalWarning'
    && isCanonicalAsset(server.args[1], cliScriptPath, constants.R_OK) && server.args[2] === 'mcp-server'
    && server.env !== null && typeof server.env === 'object' && !Array.isArray(server.env) && Object.values(server.env).every((value) => typeof value === 'string');
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Settings;
}

function writeSettings(path: string, settings: Settings): string {
  return writeJsonWithBackup(path, settings);
}

function configureMcp(opts: ClaudeInstallOptions, remove = false): ClaudeInstallResult['mcp'] {
  const configPath = opts.mcpConfigPath ?? claudeMcpConfigPath(opts.claudeDir);
  try {
    const options = { client: 'claude' as const, configPath, dryRun: opts.dryRun };
    const action = remove
      ? uninstallMcpClient(options)
      : installMcpClient({ ...options, nodePath: opts.nodePath, cliScriptPath: opts.cliScriptPath });
    const detail = remove && action === 'configured' ? 'removed' : action;
    opts.logger.info(`Claude MCP: ${detail}`);
    return { action: opts.dryRun ? 'skipped' : 'registered', detail };
  } catch (error) {
    return { action: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function installClaudeIntegration(
  opts: ClaudeInstallOptions,
): ClaudeInstallResult {
  const settingsPath = join(opts.claudeDir, 'settings.json');
  const settings = readSettings(settingsPath);

  const usCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit');
  const ptCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use');
  const stopCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'stop');
  const ptInstallCmd =
    findExistingHookCommand(settings, EVENT_POST_TOOL_USE, ptCmd) ?? ptCmd;

  const userPromptSubmit = upsertHook(settings, EVENT_USER_PROMPT_SUBMIT, usCmd);
  const postToolUse = upsertHook(settings, EVENT_POST_TOOL_USE, ptInstallCmd);
  const postToolUseFailure = upsertHook(
    settings,
    EVENT_POST_TOOL_USE_FAILURE,
    ptInstallCmd,
  );
  const stop = upsertHook(settings, EVENT_STOP, stopCmd);

  let backupPath: string | undefined;
  const anyAdded =
    userPromptSubmit === 'added' ||
    postToolUse === 'added' ||
    postToolUseFailure === 'added' ||
    stop === 'added';
  if (!opts.dryRun && anyAdded) {
    const backup = writeSettings(settingsPath, settings);
    if (backup) backupPath = backup;
  } else if (opts.dryRun) {
    opts.logger.info(
      `[dry-run] would ${userPromptSubmit === 'added' ? 'add' : 'keep'} UserPromptSubmit, ${postToolUse === 'added' ? 'add' : 'keep'} PostToolUse, ${postToolUseFailure === 'added' ? 'add' : 'keep'} PostToolUseFailure, ${stop === 'added' ? 'add' : 'keep'} Stop hook in ${settingsPath}`,
    );
  }

  const mcp = opts.skipMcpRegistration
    ? ({ action: 'skipped', detail: 'skipped by caller' } as const)
    : configureMcp(opts);

  return {
    mcp,
    hooks: { userPromptSubmit, postToolUse, postToolUseFailure, stop },
    backupPath,
  };
}

export function uninstallClaudeIntegration(
  opts: ClaudeInstallOptions,
): ClaudeInstallResult {
  const settingsPath = join(opts.claudeDir, 'settings.json');
  const settings = readSettings(settingsPath);

  const usCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit');
  const ptCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use');
  const stopCmd = hookCommand(opts.nodePath, opts.cliScriptPath, 'stop');

  const removedUs = removeHook(settings, EVENT_USER_PROMPT_SUBMIT, usCmd);
  const removedPt = removeHook(settings, EVENT_POST_TOOL_USE, ptCmd);
  const removedPtf = removeHook(settings, EVENT_POST_TOOL_USE_FAILURE, ptCmd);
  const removedStop = removeHook(settings, EVENT_STOP, stopCmd);

  let backupPath: string | undefined;
  if (!opts.dryRun && (removedUs || removedPt || removedPtf || removedStop)) {
    const backup = writeSettings(settingsPath, settings);
    if (backup) backupPath = backup;
  }

  const mcp = opts.skipMcpRegistration
    ? ({ action: 'skipped', detail: 'skipped by caller' } as const)
    : configureMcp(opts, true);

  return {
    mcp,
    hooks: {
      userPromptSubmit: removedUs ? 'added' : 'unchanged',
      postToolUse: removedPt ? 'added' : 'unchanged',
      postToolUseFailure: removedPtf ? 'added' : 'unchanged',
      stop: removedStop ? 'added' : 'unchanged',
    },
    backupPath,
  };
}
