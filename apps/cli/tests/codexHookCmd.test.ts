import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendPendingReminder, drainPendingReminders, openDb, runtimeErrorsConfigPath, runtimeErrorsSnapshot, runtimeErrorsStatePath } from '@caveat/core';
import {
  buildCodexPostToolUseWorkerJob,
  codexFeatureListEnv,
  codexContextOutput,
  codexPendingCleanupFailureText,
  isCodexToolError,
} from '../src/commands/codexHookCmd.js';

const CODEX_HOOK_CHILD_TIMEOUT_MS = 20_000;
const CODEX_HOOK_E2E_TIMEOUT_MS = 30_000;

it('formats Codex pending cleanup failures with a fixed stderr prefix', () => {
  expect(codexPendingCleanupFailureText()).toBe('[caveat:codex-hook] pending reminder cleanup failed');
});

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/codex-hooks/${name}.json`, import.meta.url), 'utf-8'),
  ) as Record<string, unknown>;
}

describe('Codex hook output formatting', () => {
  it('probes features from the requested Codex home', () => {
    expect(codexFeatureListEnv('/target/codex', { CODEX_HOME: '/wrong/home', KEEP: 'yes' }))
      .toMatchObject({ CODEX_HOME: '/target/codex', KEEP: 'yes' });
  });

  it('reports query-log failures without interrupting a successful zero-hit search', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-query-log-error-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    try {
      mkdirSync(userHome, { recursive: true });
      const db = openDb({ path: join(caveatHome, 'index', 'caveat.db') });
      db.close();
      writeFileSync(join(caveatHome, 'metrics'), 'not a directory', 'utf8');
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../src/index.ts', import.meta.url)),
          'codex-hook',
          'user-prompt-submit',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          input: JSON.stringify({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'unmatched query' }),
          encoding: 'utf-8',
          timeout: CODEX_HOOK_CHILD_TIMEOUT_MS,
          env: { ...process.env, CAVEAT_HOME: caveatHome, HOME: userHome, CAVEAT_HOOK_QUERY_LOG: 'on' },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('[caveat:codex-hook] query log error:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CODEX_HOOK_E2E_TIMEOUT_MS);

  it('records an unexpected search/open failure but not expected empty-input validation', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-runtime-error-'));
    const caveatHome = join(root, 'caveat-home'); const userHome = join(root, 'home'); const configHome = join(root, 'xdg-config'); const stateHome = join(root, 'xdg-state'); const localAppData = join(root, 'local-app-data');
    const runtimeEnv = { ...process.env, CAVEAT_HOME: caveatHome, HOME: userHome, USERPROFILE: userHome, LOCALAPPDATA: localAppData, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome };
    try {
      const runtimeConfig = runtimeErrorsConfigPath(runtimeEnv);
      mkdirSync(userHome, { recursive: true }); mkdirSync(dirname(runtimeConfig), { recursive: true });
      writeFileSync(runtimeConfig, JSON.stringify({ runtimeErrors: true }));
      mkdirSync(join(caveatHome, 'index', 'caveat.db'), { recursive: true });
      const failed = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'codex-hook', 'user-prompt-submit'], { cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify({ session_id: 's', prompt: 'search this' }), encoding: 'utf-8', timeout: CODEX_HOOK_CHILD_TIMEOUT_MS, env: runtimeEnv });
      expect(failed.status).toBe(0); expect(failed.stderr).toContain('[caveat:codex-hook] search error:');
      expect(runtimeErrorsSnapshot(0, 256, { env: runtimeEnv }).runtime_errors).toMatchObject([{ error_code: 'CAVEAT.CODEX_HOOK_FAILED' }]);

      const validationEnv = process.platform === 'win32'
        ? { ...runtimeEnv, LOCALAPPDATA: join(root, 'validation-local-app-data') }
        : { ...runtimeEnv, XDG_STATE_HOME: join(root, 'validation-state') };
      const validation = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'codex-hook', 'user-prompt-submit'], { cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify({ session_id: 's' }), encoding: 'utf-8', timeout: CODEX_HOOK_CHILD_TIMEOUT_MS, env: validationEnv });
      expect(validation.status).toBe(0); expect(existsSync(runtimeErrorsStatePath(validationEnv))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CODEX_HOOK_E2E_TIMEOUT_MS);

  it('formats user prompt context as hookSpecificOutput.additionalContext', () => {
    expect(JSON.parse(codexContextOutput('hello'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    });
  });
});

describe('Codex stop hook', () => {
  it('drains multiple user prompt contexts as one JSON object', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-user-prompt-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    try {
      mkdirSync(caveatHome, { recursive: true });
      mkdirSync(userHome, { recursive: true });
      appendPendingReminder(caveatHome, 'sess-1', 'first reminder');
      appendPendingReminder(caveatHome, 'sess-1', 'second reminder');

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../src/index.ts', import.meta.url)),
          'codex-hook',
          'user-prompt-submit',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          input: JSON.stringify({
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            prompt: 'continue',
          }),
          encoding: 'utf-8',
          timeout: CODEX_HOOK_CHILD_TIMEOUT_MS,
          env: {
            ...process.env,
            CAVEAT_HOME: caveatHome,
            HOME: userHome,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('first reminder');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('second reminder');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('\n\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CODEX_HOOK_E2E_TIMEOUT_MS);

  it('旧通知を配送し、同種のStopシグナルは一度にまとめる', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-user-prompt-'));
    const caveatHome = join(root, 'caveat-home');
    const userHome = join(root, 'home');
    try {
      mkdirSync(caveatHome, { recursive: true });
      mkdirSync(userHome, { recursive: true });
      appendPendingReminder(caveatHome, 'sess-1', 'old reminder');
      await new Promise((r) => setTimeout(r, 5));
      appendPendingReminder(
        caveatHome,
        'sess-1',
        [
          '[caveat] このセッションで外部仕様の罠に当たった可能性を示すシグナル:',
          '- tool failure: 1 件',
        ].join('\n'),
      );
      await new Promise((r) => setTimeout(r, 5));
      appendPendingReminder(
        caveatHome,
        'sess-1',
        [
          '[caveat] このセッションで外部仕様の罠に当たった可能性を示すシグナル:',
          '- tool failure: 2 件',
        ].join('\n'),
      );
      await new Promise((r) => setTimeout(r, 5));
      appendPendingReminder(caveatHome, 'sess-1', 'recent reminder 1');
      await new Promise((r) => setTimeout(r, 5));
      appendPendingReminder(caveatHome, 'sess-1', 'recent reminder 2');

      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('../src/index.ts', import.meta.url)),
          'codex-hook',
          'user-prompt-submit',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          input: JSON.stringify({
            session_id: 'sess-1',
            hook_event_name: 'UserPromptSubmit',
            prompt: 'continue',
          }),
          encoding: 'utf-8',
          timeout: CODEX_HOOK_CHILD_TIMEOUT_MS,
          env: {
            ...process.env,
            CAVEAT_HOME: caveatHome,
            HOME: userHome,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      const parsed = JSON.parse(result.stdout);
      const text = parsed.hookSpecificOutput.additionalContext;
      expect(text).toContain('old reminder');
      expect(text).not.toContain('tool failure: 1');
      expect(text).toContain('新しい苦戦シグナル: ツール失敗');
      expect(text).toContain('recent reminder 1');
      expect(text).toContain('recent reminder 2');
      expect(text).not.toContain('pending reminder');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CODEX_HOOK_E2E_TIMEOUT_MS);

  it('queues stop reminders without blocking stdout', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-stop-'));
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
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_123',
              output: 'Chunk ID: fd566f\nProcess exited with code 1\nOutput:\nfailed\n',
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
          'codex-hook',
          'stop',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          input: JSON.stringify({
            session_id: 'sess-1',
            transcript_path: transcript,
            hook_event_name: 'Stop',
            stop_hook_active: false,
          }),
          encoding: 'utf-8',
          timeout: CODEX_HOOK_CHILD_TIMEOUT_MS,
          env: {
            ...process.env,
            CAVEAT_HOME: caveatHome,
            HOME: userHome,
            // Keep the detached reindex/autosync workers a stop would spawn out
            // of this synchronous stop-reminder assertion (they race it under load).
            CAVEAT_INDEX_AUTOSYNC: 'off',
            CAVEAT_AUTO_SYNC: 'off',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      const reminders = drainPendingReminders(caveatHome, 'sess-1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain('[caveat]');
      expect(reminders[0]).toContain('tool failure: 1');
      expect(reminders[0]).toContain('own knowledge repo');
      expect(reminders[0]).toContain('caveat index');
      expect(reminders[0]).not.toContain('mcp__caveat__');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CODEX_HOOK_E2E_TIMEOUT_MS);

  it('does not requeue unchanged stop reminders for the same session', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-stop-'));
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
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_123',
              output: 'Chunk ID: fd566f\nProcess exited with code 1\nOutput:\nfailed\n',
            },
          }),
          '',
        ].join('\n'),
        'utf-8',
      );

      const runStop = () =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('../src/index.ts', import.meta.url)),
            'codex-hook',
            'stop',
          ],
          {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            input: JSON.stringify({
              session_id: 'sess-1',
              transcript_path: transcript,
              hook_event_name: 'Stop',
              stop_hook_active: false,
            }),
            encoding: 'utf-8',
            timeout: CODEX_HOOK_CHILD_TIMEOUT_MS,
            env: {
              ...process.env,
              CAVEAT_HOME: caveatHome,
              HOME: userHome,
              // Isolate stop-reminder dedup from the detached reindex/autosync
              // workers this hook would otherwise spawn: their background DB
              // writes race the second stop's search under load and flake this.
              CAVEAT_INDEX_AUTOSYNC: 'off',
              CAVEAT_AUTO_SYNC: 'off',
            },
          },
        );

      const first = runStop();
      const second = runStop();

      expect(first.status).toBe(0);
      expect(first.stdout).toBe('');
      expect(second.status).toBe(0);
      expect(second.stdout).toBe('');
      const reminders = drainPendingReminders(caveatHome, 'sess-1');
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain('tool failure: 1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, CODEX_HOOK_E2E_TIMEOUT_MS);
});

describe('isCodexToolError', () => {
  it('keeps captured successful hook payloads non-error without transcript evidence', () => {
    const payload = readFixture('user-prompt-submit');
    expect(payload.hook_event_name).toBe('UserPromptSubmit');
    expect(isCodexToolError(payload)).toBe(false);
  });

  it('recognizes the captured PostToolUse failure shape needs transcript evidence', () => {
    const payload = readFixture('post-tool-use-bash-failure');
    expect(payload.hook_event_name).toBe('PostToolUse');
    expect(payload.tool_response).toContain('command not found');
    expect(isCodexToolError(payload)).toBe(false);
  });

  it('defers captured Codex Bash payloads for transcript-backed classification', () => {
    const payload = readFixture('post-tool-use-bash-failure');
    const job = buildCodexPostToolUseWorkerJob(payload);
    expect(job).toMatchObject({
      sessionId: '019df891-9566-7223-8e9d-3d093a63b166',
      knownError: false,
      allowSymptomOnly: true,
      transcriptPath: '/tmp/caveat-codex-capture/sessions/rollout.jsonl',
      toolUseId: 'call_dASy1j0HCKmwNgfdBT7Zkh2K',
    });
    expect(job?.topicText).toContain('__caveat_missing_command_12345');
    expect(job?.failureText).toContain('command not found');
  });

  it('detects explicit exit_code fields', () => {
    expect(isCodexToolError({ exit_code: 1 })).toBe(true);
    expect(isCodexToolError({ exit_code: 0 })).toBe(false);
    expect(isCodexToolError({ tool_response: { exitCode: 2 } })).toBe(true);
  });

  it('detects process exit markers when Codex includes them in tool_response text', () => {
    expect(
      isCodexToolError({
        tool_response: 'Chunk ID: 7062ff\nProcess exited with code 9\nOutput:\nfailed\n',
      }),
    ).toBe(true);
    expect(isCodexToolError({ tool_response: 'Process exited with code 0\n' })).toBe(false);
  });

  it('detects Codex Bash failure from transcript output', () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-codex-transcript-'));
    const transcript = join(root, 'session.jsonl');
    try {
      writeFileSync(
        transcript,
        [
          JSON.stringify({
            timestamp: '2026-05-05T14:36:29.058Z',
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_123',
              output:
                'Chunk ID: fd566f\nProcess exited with code 127\nOutput:\ncommand not found\n',
            },
          }),
          '',
        ].join('\n'),
        'utf-8',
      );
      expect(
        isCodexToolError({
          transcript_path: transcript,
          tool_use_id: 'call_123',
          tool_name: 'Bash',
          tool_response: 'command not found\n',
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
