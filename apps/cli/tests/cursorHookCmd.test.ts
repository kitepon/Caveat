import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drainPendingReminders, runtimeErrorsConfigPath, runtimeErrorsStatePath } from '@caveat/core';
import { cursorContextOutput } from '../src/commands/cursorHookCmd.js';

const CURSOR_HOOK_CHILD_TIMEOUT_MS = 20_000;

describe('cursorContextOutput', () => {
  it('returns Cursor additional_context JSON, not Claude system-reminder', () => {
    const out = cursorContextOutput('hello');
    expect(JSON.parse(out)).toEqual({ additional_context: 'hello' });
    expect(out).not.toContain('system-reminder');
    expect(out).not.toContain('hookSpecificOutput');
  });

  it('queues standalone record guidance without referring to Claude MCP tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-cursor-stop-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    const transcript = join(root, 'session.jsonl');
    try {
      mkdirSync(caveatHome, { recursive: true });
      mkdirSync(userHome, { recursive: true });
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            timestamp: '2026-05-05T14:36:29.058Z',
            type: 'assistant',
            message: {
              content: [{ type: 'tool_result', is_error: true, content: 'failed' }],
            },
          }),
          '',
        ].join('\n'),
        'utf-8',
      );

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../src/index.ts', import.meta.url)),
          'cursor-hook',
          'stop',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          input: JSON.stringify({
            conversation_id: 'sess-1',
            transcript_path: transcript,
            hook_event_name: 'stop',
            stop_hook_active: false,
          }),
          encoding: 'utf-8',
          timeout: CURSOR_HOOK_CHILD_TIMEOUT_MS,
          env: {
            ...process.env,
            CAVEAT_HOME: caveatHome,
            HOME: userHome,
            CAVEAT_INDEX_AUTOSYNC: 'off',
            CAVEAT_AUTO_SYNC: 'off',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      const reminders = drainPendingReminders(caveatHome, 'sess-1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain('own knowledge repo');
      expect(reminders[0]).toContain('caveat index');
      expect(reminders[0]).not.toContain('mcp__caveat__');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a payload that starts with a UTF-8 BOM, as Cursor CLI on Windows sends it', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-cursor-bom-'));
    const caveatHome = join(root, 'caveat-home'); const userHome = join(root, 'home');
    const env = { ...process.env, CAVEAT_HOME: caveatHome, HOME: userHome, USERPROFILE: userHome, LOCALAPPDATA: join(root, 'local-app-data'), XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_STATE_HOME: join(root, 'xdg-state'), CAVEAT_INDEX_AUTOSYNC: 'off', CAVEAT_AUTO_SYNC: 'off' };
    try {
      const runtimeConfig = runtimeErrorsConfigPath(env);
      mkdirSync(caveatHome, { recursive: true }); mkdirSync(dirname(runtimeConfig), { recursive: true });
      writeFileSync(runtimeConfig, JSON.stringify({ runtimeErrors: true }));
      const payload = JSON.stringify({ conversation_id: 'sess-bom', hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'echo ok' }, tool_output: '{"output":"ok\\r\\n","exitCode":0}' });
      for (const [command, name] of [['cursor-hook', 'post-tool-use'], ['hook', 'post-tool-use'], ['codex-hook', 'post-tool-use']] as const) {
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), command, name],
          { cwd: fileURLToPath(new URL('..', import.meta.url)), input: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${payload}\r\n`, 'utf-8')]), encoding: 'utf-8', timeout: CURSOR_HOOK_CHILD_TIMEOUT_MS, env },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('json parse error');
      }
      expect(existsSync(runtimeErrorsStatePath(env))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
