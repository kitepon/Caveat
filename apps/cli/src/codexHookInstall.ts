import { constants, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { powershellCallPrefix, type Logger } from '@caveat/core';
import { parse as parseToml } from 'smol-toml';
import { commandTokens, isCanonicalAsset, quoteCommandPath, writeFileWithBackup, writeJsonWithBackup } from './installShared.js';

export interface CodexHookInstallOptions {
  codexHome: string;
  cliScriptPath: string;
  nodePath: string;
  dryRun: boolean;
  logger: Logger;
  platform?: NodeJS.Platform;
}

export interface CodexHookInstallResult {
  hooks: {
    userPromptSubmit: 'added' | 'unchanged' | 'skipped';
    postToolUse: 'added' | 'unchanged' | 'skipped';
    stop: 'added' | 'unchanged' | 'skipped';
  };
  feature: 'enabled' | 'unchanged' | 'blocked';
  blockedReason?: string;
  backupPath?: string;
  configBackupPath?: string;
}

export interface CodexHookInstallationStatus {
  installation: 'not-installed' | 'installed' | 'partial';
  hooksPath: string;
  hooks: {
    userPromptSubmit: boolean;
    postToolUse: boolean;
    stop: boolean;
  };
  legacyTimeoutSec: {
    userPromptSubmit: boolean;
    postToolUse: boolean;
    stop: boolean;
  };
}

type HookEvent = 'UserPromptSubmit' | 'PostToolUse' | 'Stop';
type HookCommand = {
  type: string;
  command: string;
  timeout?: number | null;
  timeoutSec?: number | null;
  async?: boolean;
  statusMessage?: string | null;
};
type HookEntry = {
  matcher?: string | null;
  hooks: HookCommand[];
};
type HooksJson = {
  hooks?: Partial<Record<HookEvent, HookEntry[]>>;
  [key: string]: unknown;
};

function hookCommand(
  nodePath: string,
  cliScriptPath: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
  platform: NodeJS.Platform = process.platform,
): string {
  return `${powershellCallPrefix(platform)}${quoteCommandPath(nodePath)} ${quoteCommandPath(cliScriptPath)} codex-hook ${event}`;
}

function eventCommandFragment(event: 'user-prompt-submit' | 'post-tool-use' | 'stop'): string {
  return `codex-hook ${event}`;
}

function isSameHookCommand(actual: string, expected: string): boolean {
  const normalizedTokens = (command: string): string[] | null => {
    const parsed = commandTokens(command);
    return parsed?.[0] === '&' ? parsed.slice(1) : parsed;
  };
  const actualTokens = normalizedTokens(actual);
  const expectedTokens = normalizedTokens(expected);
  return actualTokens !== null
    && expectedTokens !== null
    && actualTokens.length === expectedTokens.length
    && actualTokens.every((token, index) => token === expectedTokens[index]);
}

function isCaveatCodexHookCommand(
  actual: string,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): boolean {
  const lower = actual.toLowerCase();
  return lower.includes('caveat') && actual.includes(eventCommandFragment(event));
}

/** Exact read-only detector used by factory diagnostics. */
export function isCanonicalCaveatCodexHookCommand(actual: string, event: 'user-prompt-submit' | 'post-tool-use' | 'stop', nodePath: string, cliScriptPath: string): boolean {
  const parsed = commandTokens(actual);
  const tokens = parsed?.[0] === '&' ? parsed.slice(1) : parsed;
  return tokens?.length === 4 && isCanonicalAsset(tokens[0], nodePath, constants.X_OK) && isCanonicalAsset(tokens[1], cliScriptPath, constants.R_OK) && tokens[2] === 'codex-hook' && tokens[3] === event;
}

export function isCanonicalCaveatCodexHookEntry(
  value: unknown,
  event: 'user-prompt-submit' | 'post-tool-use' | 'stop',
  nodePath: string,
  cliScriptPath: string,
): boolean {
  if (!isPlainRecord(value)
    || typeof value.type !== 'string'
    || typeof value.command !== 'string') return false;
  return value.type === 'command'
    && isCanonicalCaveatCodexHookCommand(value.command, event, nodePath, cliScriptPath)
    && value.timeout === 5
    && value.timeoutSec === undefined
    && value.async === false
    && value.statusMessage === null;
}

function hasCaveatHook(hooksJson: HooksJson, event: HookEvent, fragment: string): boolean {
  return (
    hooksJson.hooks?.[event]?.some((entry) =>
      entry.hooks?.some((h) => h.command.includes(fragment)),
    ) ?? false
  );
}

function readHooks(path: string): HooksJson {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as HooksJson;
}

function upsertHook(
  hooksJson: HooksJson,
  event: HookEvent,
  command: string,
  subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): 'added' | 'unchanged' {
  hooksJson.hooks ??= {};
  const list = (hooksJson.hooks[event] ??= []);
  for (const entry of list) {
    for (const hook of entry.hooks ?? []) {
      if (isSameHookCommand(hook.command, command)
        && hook.type === 'command'
        && hook.timeout === 5
        && hook.timeoutSec === undefined
        && hook.async === false
        && hook.statusMessage === null) return 'unchanged';
      if (isSameHookCommand(hook.command, command)
        || isCaveatCodexHookCommand(hook.command, subcommand)) {
        hook.command = command;
        hook.type = 'command';
        hook.timeout = 5;
        delete hook.timeoutSec;
        hook.async = false;
        hook.statusMessage = null;
        return 'added';
      }
    }
  }
  list.push({
    hooks: [
      {
        type: 'command',
        command,
        timeout: 5,
        async: false,
        statusMessage: null,
      },
    ],
  });
  return 'added';
}

function removeHook(
  hooksJson: HooksJson,
  event: HookEvent,
  command: string,
  subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop',
): boolean {
  const list = hooksJson.hooks?.[event];
  if (!list) return false;
  const before = list.length;
  const filtered = list.filter(
    (entry) => !entry.hooks?.some((h) =>
      isSameHookCommand(h.command, command) || isCaveatCodexHookCommand(h.command, subcommand),
    ),
  );
  if (filtered.length === before) return false;
  hooksJson.hooks![event] = filtered;
  return true;
}

function enableCodexHooksFeature(raw: string):
  | { status: 'enabled'; text: string; changed: boolean }
  | { status: 'blocked'; text: string; changed: false; reason: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    return {
      status: 'blocked',
      text: raw,
      changed: false,
      reason: 'config.toml is invalid TOML; fix it before installing Caveat hooks',
    };
  }
  const featureValue = parsed.features;
  if (featureValue !== undefined && !isPlainRecord(featureValue)) {
    return {
      status: 'blocked',
      text: raw,
      changed: false,
      reason: 'config.toml features value is not a table',
    };
  }
  const features = featureValue as Record<string, unknown> | undefined;
  const canonicalValue = features?.hooks;
  const legacyValue = features?.codex_hooks;
  if (canonicalValue !== undefined && typeof canonicalValue !== 'boolean') {
    return { status: 'blocked', text: raw, changed: false, reason: '[features].hooks must be boolean' };
  }
  if (legacyValue !== undefined && typeof legacyValue !== 'boolean') {
    return { status: 'blocked', text: raw, changed: false, reason: '[features].codex_hooks must be boolean' };
  }
  if (canonicalValue === false) {
    return { status: 'blocked', text: raw, changed: false, reason: '[features].hooks is explicitly false' };
  }
  if (legacyValue === false) {
    return {
      status: 'blocked',
      text: raw,
      changed: false,
      reason: canonicalValue === true
        ? '[features].hooks conflicts with the deprecated codex_hooks alias'
        : '[features].codex_hooks is explicitly false',
    };
  }
  if (canonicalValue === true && legacyValue === undefined) {
    return { status: 'enabled', text: raw, changed: false };
  }

  const lines = raw.split(/\r?\n/);
  const codeLines = maskTomlStringsAndComments(raw).split(/\r?\n/);
  const featureHeaders = codeLines
    .map((line, index) => (/^\s*\[\s*features\s*]\s*$/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (featureValue === undefined) {
    const prefix = raw.trimEnd();
    const text = `${prefix}${prefix ? '\n\n' : ''}[features]\nhooks = true\n`;
    return { status: 'enabled', text, changed: true };
  }
  if (featureHeaders.length !== 1) {
    return {
      status: 'blocked',
      text: raw,
      changed: false,
      reason: 'config.toml uses a features table shape that Caveat will not rewrite safely',
    };
  }
  const featuresStart = featureHeaders[0]!;

  const assignments: Array<{ index: number; key: 'hooks' | 'codex_hooks' }> = [];
  for (let i = featuresStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[\[?/.test(codeLines[i]!)) {
      break;
    }
    const assignment = /^\s*(hooks|codex_hooks)\s*=/.exec(codeLines[i]!);
    if (assignment) {
      assignments.push({ index: i, key: assignment[1]! as 'hooks' | 'codex_hooks' });
    }
  }
  const canonical = assignments.filter((assignment) => assignment.key === 'hooks');
  const legacy = assignments.filter((assignment) => assignment.key === 'codex_hooks');
  if ((canonicalValue !== undefined && canonical.length !== 1)
    || (legacyValue !== undefined && legacy.length !== 1)) {
    return {
      status: 'blocked',
      text: raw,
      changed: false,
      reason: '[features].hooks uses a key shape that Caveat will not rewrite safely',
    };
  }
  const current = canonical[0];
  const deprecated = legacy[0];
  if (canonicalValue === true && legacyValue === true && current && deprecated) {
    const inlineComment = /(#.*)$/.exec(lines[deprecated.index]!)?.[1];
    lines.splice(deprecated.index, 1);
    if (inlineComment) {
      const canonicalIndex = current.index > deprecated.index ? current.index - 1 : current.index;
      lines.splice(canonicalIndex + 1, 0, inlineComment);
    }
    return { status: 'enabled', text: `${lines.join('\n').trimEnd()}\n`, changed: true };
  }
  if (legacyValue === true && canonicalValue === undefined && deprecated) {
    lines[deprecated.index] = lines[deprecated.index]!.replace(/\bcodex_hooks\b/, 'hooks');
    return { status: 'enabled', text: `${lines.join('\n').trimEnd()}\n`, changed: true };
  }
  lines.splice(featuresStart + 1, 0, 'hooks = true');
  return { status: 'enabled', text: `${lines.join('\n').trimEnd()}\n`, changed: true };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function maskTomlStringsAndComments(raw: string): string {
  let state: 'code' | 'basic' | 'literal' | 'multi-basic' | 'multi-literal' | 'comment' = 'code';
  let output = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    const triple = raw.slice(i, i + 3);
    if (char === '\n') {
      output += '\n';
      if (state === 'comment') state = 'code';
      continue;
    }
    if (state === 'comment') { output += ' '; continue; }
    if (state === 'basic') {
      output += ' ';
      if (char === '\\' && i + 1 < raw.length) { output += raw[i + 1] === '\n' ? '\n' : ' '; i += 1; }
      else if (char === '"') state = 'code';
      continue;
    }
    if (state === 'literal') { output += ' '; if (char === "'") state = 'code'; continue; }
    if (state === 'multi-basic') {
      if (triple === '"""') { output += '   '; i += 2; state = 'code'; }
      else { output += ' '; if (char === '\\' && i + 1 < raw.length) { output += raw[i + 1] === '\n' ? '\n' : ' '; i += 1; } }
      continue;
    }
    if (state === 'multi-literal') {
      if (triple === "'''") { output += '   '; i += 2; state = 'code'; }
      else output += ' ';
      continue;
    }
    if (char === '#') { output += ' '; state = 'comment'; }
    else if (triple === '"""') { output += '   '; i += 2; state = 'multi-basic'; }
    else if (triple === "'''") { output += '   '; i += 2; state = 'multi-literal'; }
    else if (char === '"') { output += ' '; state = 'basic'; }
    else if (char === "'") { output += ' '; state = 'literal'; }
    else output += char;
  }
  return output;
}

export function installCodexHooks(opts: CodexHookInstallOptions): CodexHookInstallResult {
  const hooksPath = join(opts.codexHome, 'hooks.json');
  const configPath = join(opts.codexHome, 'config.toml');
  const rawConfig = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
  const enabled = enableCodexHooksFeature(rawConfig);
  if (enabled.status === 'blocked') {
    return {
      hooks: { userPromptSubmit: 'skipped', postToolUse: 'skipped', stop: 'skipped' },
      feature: 'blocked',
      blockedReason: enabled.reason,
    };
  }

  const hooksJson = readHooks(hooksPath);

  const userPromptSubmit = upsertHook(
    hooksJson,
    'UserPromptSubmit',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit', opts.platform),
    'user-prompt-submit',
  );
  const postToolUse = upsertHook(
    hooksJson,
    'PostToolUse',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use', opts.platform),
    'post-tool-use',
  );
  const stop = upsertHook(
    hooksJson,
    'Stop',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'stop', opts.platform),
    'stop',
  );

  const anyHookAdded =
    userPromptSubmit === 'added' || postToolUse === 'added' || stop === 'added';

  let backupPath: string | undefined;
  let configBackupPath: string | undefined;
  if (opts.dryRun) {
    opts.logger.info(`[dry-run] would update ${hooksPath}`);
    opts.logger.info(`[dry-run] would ensure [features].hooks = true in ${configPath}`);
  } else {
    if (anyHookAdded) {
      const backup = writeJsonWithBackup(hooksPath, hooksJson);
      if (backup) backupPath = backup;
    }
    if (enabled.changed) {
      const backup = writeFileWithBackup(configPath, enabled.text);
      if (backup) configBackupPath = backup;
    }
  }

  return {
    hooks: { userPromptSubmit, postToolUse, stop },
    feature: enabled.changed ? 'enabled' : 'unchanged',
    backupPath,
    configBackupPath,
  };
}

export function uninstallCodexHooks(opts: CodexHookInstallOptions): CodexHookInstallResult {
  const hooksPath = join(opts.codexHome, 'hooks.json');
  const hooksJson = readHooks(hooksPath);
  const userPromptSubmitRemoved = removeHook(
    hooksJson,
    'UserPromptSubmit',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'user-prompt-submit', opts.platform),
    'user-prompt-submit',
  );
  const postToolUseRemoved = removeHook(
    hooksJson,
    'PostToolUse',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'post-tool-use', opts.platform),
    'post-tool-use',
  );
  const stopRemoved = removeHook(
    hooksJson,
    'Stop',
    hookCommand(opts.nodePath, opts.cliScriptPath, 'stop', opts.platform),
    'stop',
  );

  let backupPath: string | undefined;
  if (opts.dryRun) {
    opts.logger.info(`[dry-run] would remove Caveat Codex hooks from ${hooksPath}`);
  } else if (userPromptSubmitRemoved || postToolUseRemoved || stopRemoved) {
    const backup = writeJsonWithBackup(hooksPath, hooksJson);
    if (backup) backupPath = backup;
  }

  return {
    hooks: {
      userPromptSubmit: userPromptSubmitRemoved ? 'added' : 'unchanged',
      postToolUse: postToolUseRemoved ? 'added' : 'unchanged',
      stop: stopRemoved ? 'added' : 'unchanged',
    },
    feature: 'unchanged',
    backupPath,
  };
}

export function detectCodexHookInstallation(codexHome: string): CodexHookInstallationStatus {
  const hooksPath = join(codexHome, 'hooks.json');
  const hooksJson = readHooks(hooksPath);
  const hooks = {
    userPromptSubmit: hasCaveatHook(
      hooksJson,
      'UserPromptSubmit',
      eventCommandFragment('user-prompt-submit'),
    ),
    postToolUse: hasCaveatHook(hooksJson, 'PostToolUse', eventCommandFragment('post-tool-use')),
    stop: hasCaveatHook(hooksJson, 'Stop', eventCommandFragment('stop')),
  };
  const hasLegacyTimeoutSec = (event: HookEvent, fragment: string): boolean =>
    hooksJson.hooks?.[event]?.some((entry) => entry.hooks?.some((hook) =>
      hook.command.includes(fragment) && hook.timeoutSec !== undefined)) ?? false;
  const legacyTimeoutSec = {
    userPromptSubmit: hasLegacyTimeoutSec('UserPromptSubmit', eventCommandFragment('user-prompt-submit')),
    postToolUse: hasLegacyTimeoutSec('PostToolUse', eventCommandFragment('post-tool-use')),
    stop: hasLegacyTimeoutSec('Stop', eventCommandFragment('stop')),
  };
  const count = Object.values(hooks).filter(Boolean).length;
  const hasLegacy = Object.values(legacyTimeoutSec).some(Boolean);
  return {
    installation: count === 0 ? 'not-installed' : count === 3 && !hasLegacy ? 'installed' : 'partial',
    hooksPath,
    hooks,
    legacyTimeoutSec,
  };
}
