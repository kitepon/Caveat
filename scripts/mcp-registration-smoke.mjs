#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveAgentConfigPaths } from '../apps/cli/src/installShared.ts';

// 公開npm packageの依存を使い、登録済みcommandで実際にMCP検索する。秘密値・検索本文は出力しない。
const packageRoot = resolve(process.argv[2] ?? 'apps/cli');
const require = createRequire(join(packageRoot, 'package.json'));
const { parse } = require('smol-toml');
const paths = resolveAgentConfigPaths();
const targets = [
  ['claude', paths.claudeMcp, 'json', 'mcpServers'],
  ['codex', join(paths.codexHome, 'config.toml'), 'toml', 'mcp_servers'],
  ['grok', join(paths.grokHome, 'config.toml'), 'toml', 'mcp_servers'],
  ['cursor', join(paths.cursorDir, 'mcp.json'), 'json', 'mcpServers'],
];

for (const [client, path, format, key] of targets) {
  const source = readFileSync(path, 'utf8');
  const config = (format === 'toml' ? parse(source) : JSON.parse(source))[key]?.caveat;
  assert.ok(config, `${client}: Caveat登録がありません`);
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); }
    catch (error) { for (const { reject } of pending.values()) reject(error); return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if (response.error) request.reject(new Error(`${client}: MCP error ${response.error.code}`));
    else request.resolve(response.result);
  });
  child.on('error', (error) => { for (const { reject } of pending.values()) reject(error); });
  child.on('exit', (code) => {
    for (const { reject } of pending.values()) reject(new Error(`${client}: MCPが途中終了しました (${code}, stderr ${stderr.length} bytes)`));
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const timeout = setTimeout(() => {
    for (const { reject } of pending.values()) reject(new Error(`${client}: MCP応答が30秒以内にありません`));
    child.kill();
  }, 30_000);
  try {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'caveat-release-smoke', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await call('tools/list', {});
    assert.ok(listed.tools.some((tool) => tool.name === 'caveat_search'));
    const searched = await call('tools/call', { name: 'caveat_search', arguments: { query: 'git' } });
    assert.notEqual(searched.isError, true, `${client}: caveat_searchが失敗しました`);
    assert.ok(searched.content?.some((item) => item.type === 'text'));
    process.stdout.write(`${JSON.stringify({ client, status: 'ok', tools: listed.tools.length, search: 'ok' })}\n`);
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
