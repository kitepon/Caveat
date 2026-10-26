import { it, expect, vi, beforeEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { observeRuntimeError } from '@caveat/core';
import { loadMcpRuntime } from '../src/mcpRuntime.js';
import { runMcpServer } from '../src/commands/mcpServer.js';
import { CAVEAT_VERSION } from '../src/version.js';
vi.mock('@caveat/core', () => ({ observeRuntimeError: vi.fn() }));
vi.mock('../src/mcpRuntime.js', () => ({ loadMcpRuntime: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
it('loads the runtime at the MCP command boundary and passes the product version', async () => {
  const start = vi.fn().mockResolvedValue(undefined);
  vi.mocked(loadMcpRuntime).mockResolvedValue({ startMcpStdioServer: start });
  await runMcpServer();
  expect(start).toHaveBeenCalledWith({ productVersion: CAVEAT_VERSION });
  expect(observeRuntimeError).not.toHaveBeenCalled();
});
for (const phase of ['load', 'start'] as const) it(`retains the original ${phase} failure and MCP diagnostic`, async () => {
  const failure = Error('controlled MCP failure');
  if (phase === 'load') vi.mocked(loadMcpRuntime).mockRejectedValue(failure);
  else vi.mocked(loadMcpRuntime).mockResolvedValue({ startMcpStdioServer: vi.fn().mockRejectedValue(failure) });
  await expect(runMcpServer()).rejects.toBe(failure);
  expect(observeRuntimeError).toHaveBeenCalledExactlyOnceWith('CAVEAT.MCP_SERVER_FAILED', { version: CAVEAT_VERSION, impact: 'feature_unavailable' });
});
it('ordinary packaged hooks work with the MCP runtime asset absent', () => {
  const cliRoot = fileURLToPath(new URL('../', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'caveat-mcp-command-boundary-'));
  try {
    cpSync(join(cliRoot, 'dist'), join(root, 'dist'), { recursive: true });
    symlinkSync(join(cliRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const home = join(root, 'profile'); mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CAVEAT_HOME: join(home, '.caveat'), LOCALAPPDATA: join(home, 'local'), XDG_STATE_HOME: join(home, 'state'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), GROK_HOME: join(home, '.grok'), CURSOR_HOME: join(home, '.cursor') };
    writeFileSync(join(home, '.caveatrc.json'), JSON.stringify({ runtimeErrors: true, knowledgeRepo: 'own' }));
    const cli = join(root, 'dist', 'caveat.js');
    const init = spawnSync(process.execPath, [cli, 'init', '--yes'], { env, cwd: home, encoding: 'utf8', timeout: 60000 });
    expect(init.status, init.stderr).toBe(0);
    rmSync(join(root, 'dist', 'mcp-server.js'));
    const input = JSON.stringify({ session_id: 'owned-mcp-boundary-fixture', cwd: home, prompt: 'ordinary prompt' });
    const hook = spawnSync(process.execPath, [cli, 'codex-hook', 'user-prompt-submit'], { env, cwd: home, input, encoding: 'utf8', timeout: 5000 });
    expect(hook.status, hook.stderr).toBe(0);
    expect(hook.error).toBeUndefined();
    expect(hook.stdout).toBe('');
    expect(hook.stderr).toBe('');
    expect(readFileSync(join(home, '.caveatrc.json'), 'utf8')).not.toContain('runtimeErrorReportCredentialFile');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15000);
