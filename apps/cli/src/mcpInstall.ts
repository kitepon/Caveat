import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { writeFileWithBackup } from './installShared.js';

export type McpClient = 'claude' | 'codex' | 'grok' | 'cursor';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  if (isDeepStrictEqual(previous, registration)) return 'unchanged';
  if (dryRun) return 'dry-run';
  const nextServers = { ...servers };
  if (registration === undefined) delete nextServers.caveat;
  else nextServers.caveat = registration;
  const next = { ...current, [key]: nextServers };
  writeFileWithBackup(configPath, json ? `${JSON.stringify(next, null, 2)}\n` : stringify(next));
  const observed = decode(readFileSync(configPath, 'utf8'));
  if (!isDeepStrictEqual(observed, next)) {
    throw new Error(`mcp_config_readback_failed: ${client}の設定読戻しが一致しません`);
  }
  return 'configured';
}
