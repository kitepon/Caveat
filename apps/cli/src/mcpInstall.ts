import { constants, existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { isCanonicalAsset, writeFileWithBackup } from './installShared.js';

export type McpClient = 'claude' | 'codex' | 'grok' | 'cursor';

/** Verify the executable and arguments shared by every stdio registration. */
export function isCaveatStdioMcpRegistration(value: unknown, nodePath: string, cliScriptPath: string): boolean {
  if (!object(value)) return false;
  return isCanonicalAsset(value.command, nodePath, constants.X_OK)
    && Array.isArray(value.args)
    && value.args.length === 3
    && value.args[0] === '--disable-warning=ExperimentalWarning'
    && isCanonicalAsset(value.args[1], cliScriptPath, constants.R_OK)
    && value.args[2] === 'mcp-server';
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** TOML tables may have a null prototype. Preserve scalar types and date forms. */
export function sameTomlValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date
      && isDeepStrictEqual(left, right) && left.toISOString() === right.toISOString();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameTomlValue(value, right[index]));
  }
  const table = (value: unknown): value is Record<string, unknown> => object(value)
    && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype);
  if (table(left) && table(right)) {
    return Object.keys(left).length === Object.keys(right).length
      && Object.keys(left).every((key) => Object.hasOwn(right, key) && sameTomlValue(left[key], right[key]));
  }
  return isDeepStrictEqual(left, right);
}

interface McpConfigOptions {
  client: McpClient;
  configPath: string;
  dryRun: boolean;
}

/** 設定形式の差を製品内に閉じ込め、Caveat以外の登録と利用者の指定を保持する。 */
export function installMcpClient(options: McpConfigOptions & { nodePath: string; cliScriptPath: string }) {
  return updateMcpClient(options, (previous) => ({
    ...previous,
    ...(options.client === 'claude' ? { type: 'stdio', env: previous?.env ?? {} } : {}),
    command: options.nodePath,
    args: ['--disable-warning=ExperimentalWarning', options.cliScriptPath, 'mcp-server'],
  }));
}

export function uninstallMcpClient(options: McpConfigOptions) {
  return updateMcpClient(options, () => undefined);
}

function updateMcpClient(
  options: McpConfigOptions,
  update: (previous: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
): 'configured' | 'unchanged' | 'dry-run' {
  const { client, configPath, dryRun } = options;
  const json = client === 'cursor' || client === 'claude';
  const decode = (text: string): unknown => json ? JSON.parse(text) : parse(text);
  const sameValue = json ? isDeepStrictEqual : sameTomlValue;
  const current = existsSync(configPath) ? decode(readFileSync(configPath, 'utf8')) : {};
  const key = json ? 'mcpServers' : 'mcp_servers';
  if (!object(current) || (current[key] !== undefined && !object(current[key]))) {
    throw new Error(`mcp_config_invalid: ${client}のMCP設定がobjectではありません`);
  }
  const servers = (current[key] ?? {}) as Record<string, unknown>;
  if (servers.caveat !== undefined && !object(servers.caveat)) {
    throw new Error(`mcp_config_invalid: ${client}のCaveat登録がobjectではありません`);
  }
  const previous = servers.caveat as Record<string, unknown> | undefined;
  const registration = update(previous);
  if (sameValue(previous, registration)) return 'unchanged';
  if (dryRun) return 'dry-run';
  const nextServers = { ...servers };
  if (registration === undefined) delete nextServers.caveat;
  else nextServers.caveat = registration;
  const next = { ...current, [key]: nextServers };
  const encoded = json ? `${JSON.stringify(next, null, 2)}\n` : stringify(next);
  if (!sameValue(decode(encoded), next)) {
    throw new Error(`mcp_config_roundtrip_failed: ${client}の設定を意味を保って再出力できません`);
  }
  writeFileWithBackup(configPath, encoded);
  const observed = decode(readFileSync(configPath, 'utf8'));
  if (!sameValue(observed, next)) {
    throw new Error(`mcp_config_readback_failed: ${client}の設定読戻しが一致しません`);
  }
  return 'configured';
}
