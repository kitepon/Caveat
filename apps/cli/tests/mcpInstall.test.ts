import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { installMcpClient } from '../src/mcpInstall.js';

describe('製品が所有するMCP登録', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'caveat-mcp-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  for (const client of ['claude', 'codex', 'grok', 'cursor'] as const) {
    it(`${client}: 初回登録と再実行で他の設定を保持する`, () => {
      const json = client === 'cursor' || client === 'claude';
      const configPath = join(root, json ? 'mcp.json' : 'config.toml');
      const key = json ? 'mcpServers' : 'mcp_servers';
      const current = { model: '利用者指定', features: { hooks: false }, [key]: {
        other: { command: 'other' },
        caveat: { command: '古い場所', args: [], enabled: false, tool_timeout_sec: 240, env: { CAVEAT_HOME: '利用者の記録' } },
      } };
      const original = json ? JSON.stringify(current) : stringify(current);
      writeFileSync(configPath, original);
      const options = { client, configPath, nodePath: process.execPath, cliScriptPath: join(root, '空白のある場所', 'caveat.js'), dryRun: false };
      expect(installMcpClient(options)).toBe('configured');
      const text = readFileSync(configPath, 'utf8');
      const updated = json ? JSON.parse(text) : parse(text);
      expect(updated).toEqual({ ...current, [key]: { ...current[key], caveat: {
        ...current[key]!.caveat,
        ...(client === 'claude' ? { type: 'stdio' } : {}),
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', options.cliScriptPath, 'mcp-server'],
      } } });
      expect(installMcpClient(options)).toBe('unchanged');
      expect(readFileSync(configPath, 'utf8')).toBe(text);
      const backups = readdirSync(root).filter((name) => name.includes('.caveat-backup-'));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(root, backups[0]!), 'utf8')).toBe(original);
    });

    it(`${client}: 不正な既存設定を変更せず失敗する`, () => {
      const configPath = join(root, 'config');
      writeFileSync(configPath, '壊れた設定 {{');
      expect(() => installMcpClient({ client, configPath, nodePath: process.execPath, cliScriptPath: '/caveat.js', dryRun: false })).toThrow();
      expect(readFileSync(configPath, 'utf8')).toBe('壊れた設定 {{');
      expect(readdirSync(root)).toEqual(['config']);
    });
  }

  it('未作成の設定はdry-runで書かない', () => {
    expect(installMcpClient({ client: 'codex', configPath: join(root, 'new.toml'), nodePath: process.execPath, cliScriptPath: '/caveat.js', dryRun: true })).toBe('dry-run');
    expect(readdirSync(root)).toEqual([]);
  });
});
