import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, recordRuntimeError, runtimeErrorsConfigPath, runtimeErrorsStatePath } from '@caveat/core';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repo, 'apps', 'cli', 'dist', 'caveat.js');

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 20_000 });
}

function json(result: ReturnType<typeof run>) {
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, any>;
}

function isolated() {
  const root = mkdtempSync(join(tmpdir(), 'caveat-factory-cli-'));
  const home = join(root, 'home'); const caveatHome = join(root, 'caveat');
  const configHome = join(root, 'xdg-config'); const stateHome = join(root, 'xdg-state'); const localAppData = join(root, 'local-app-data');
  mkdirSync(home, { recursive: true }); mkdirSync(caveatHome, { recursive: true });
  const codexHome = join(root, 'codex');
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: localAppData, CAVEAT_HOME: caveatHome, CODEX_HOME: codexHome, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, PATH: process.env.PATH ?? '' };
  const runtimeConfig = runtimeErrorsConfigPath(env);
  mkdirSync(dirname(runtimeConfig), { recursive: true });
  writeFileSync(runtimeConfig, JSON.stringify({ runtimeErrors: true }));
  return { root, home, caveatHome, codexHome, env };
}

function readyFactory(fixture: ReturnType<typeof isolated>) {
  const db = openDb({ path: join(fixture.caveatHome, 'index', 'caveat.db') }); db.close();
  const own = join(fixture.caveatHome, 'own'); const remote = join(fixture.root, 'remote.git'); mkdirSync(own, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' }); execFileSync('git', ['init'], { cwd: own, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: own }); execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: own });
  writeFileSync(join(own, 'README.md'), 'fixture\n'); execFileSync('git', ['add', '.'], { cwd: own }); execFileSync('git', ['commit', '-m', 'fixture'], { cwd: own, stdio: 'pipe' }); execFileSync('git', ['branch', '-M', 'main'], { cwd: own }); execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: own }); execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: own, stdio: 'pipe' });
  const quoted = (value: string) => /[\s\\]/.test(value) ? `"${value}"` : value;
  const nodeCommand = quoted(process.execPath); const cliCommand = quoted(cli);
  writeFileSync(join(fixture.home, '.claude.json'), JSON.stringify({ mcpServers: { caveat: { type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', cli, 'mcp-server'], env: {} } } }));
  mkdirSync(join(fixture.home, '.claude'), { recursive: true }); writeFileSync(join(fixture.home, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: `${nodeCommand} ${cliCommand} hook user-prompt-submit` }] }], PostToolUse: [{ hooks: [{ command: `${nodeCommand} ${cliCommand} hook post-tool-use` }] }], PostToolUseFailure: [{ hooks: [{ command: `${nodeCommand} ${cliCommand} hook post-tool-use` }] }], Stop: [{ hooks: [{ command: `${nodeCommand} ${cliCommand} hook stop` }] }] } }));
  const codexHook = (subcommand: string) => ({ type: 'command', command: `${nodeCommand} ${cliCommand} codex-hook ${subcommand}`, timeout: 5, async: false, statusMessage: null });
  mkdirSync(fixture.codexHome, { recursive: true }); writeFileSync(join(fixture.codexHome, 'config.toml'), '[features]\nhooks = true\n'); writeFileSync(join(fixture.codexHome, 'hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [codexHook('user-prompt-submit')] }], PostToolUse: [{ hooks: [codexHook('post-tool-use')] }], Stop: [{ hooks: [codexHook('stop')] }] } }));
}

function readyCursor(fixture: ReturnType<typeof isolated>) {
  const quoted = (value: string) => /[\s\\]/.test(value) ? `"${value}"` : value;
  const nodeCommand = quoted(process.execPath); const cliCommand = quoted(cli);
  const cursorHook = (subcommand: string) => ({ command: `${nodeCommand} ${cliCommand} cursor-hook ${subcommand}`, timeout: 10 });
  const cursorDir = join(fixture.home, '.cursor'); mkdirSync(cursorDir, { recursive: true }); writeFileSync(join(cursorDir, 'hooks.json'), JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [cursorHook('user-prompt-submit')], postToolUse: [cursorHook('post-tool-use')], postToolUseFailure: [cursorHook('post-tool-use')], stop: [cursorHook('stop')] } }));
}

describe('built factory/runtime CLI contracts', { timeout: process.platform === 'win32' ? 30_000 : 5_000 }, () => {
  it('独自のClaude・Cursor設定先を導入と同じ場所で診断する', () => {
    const fixture = isolated(); readyFactory(fixture); readyCursor(fixture);
    const claudeDir = join(fixture.root, 'claude-custom');
    const cursorDir = join(fixture.root, 'cursor-custom');
    renameSync(join(fixture.home, '.claude'), claudeDir);
    renameSync(join(fixture.home, '.claude.json'), join(claudeDir, '.claude.json'));
    renameSync(join(fixture.home, '.cursor'), cursorDir);
    const env = { ...fixture.env, CLAUDE_CONFIG_DIR: claudeDir, CURSOR_HOME: cursorDir };
    const result = run(['factory-diagnostics', '--json', '--require-connector', 'cursor'], env);
    expect(json(result)).toMatchObject({ overall: { status: 'ready' }, connectors: {
      claude: { status: 'ready' }, cursor: { compatibility_status: 'ready' },
    } });
    expect(result.status).toBe(0);
    const cursor = run(['cursor-hook', 'diagnostics'], env);
    expect(cursor.status).toBe(0);
    expect(JSON.parse(cursor.stdout).installation).toBe('installed');
  });

  it('導入時に保持したClaude MCPの環境変数とtimeoutを診断でも受け入れる', () => {
    const fixture = isolated(); readyFactory(fixture);
    const configPath = join(fixture.home, '.claude.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.mcpServers.caveat.env = { CAVEAT_AUTO_SYNC: 'off' };
    config.mcpServers.caveat.tool_timeout_sec = 240;
    writeFileSync(configPath, JSON.stringify(config));
    const result = run(['factory-diagnostics', '--json'], fixture.env);
    expect(json(result).connectors.claude.mcp.status).toBe('ready');
    expect(result.status).toBe(0);
  });

  it.each([
    ['hooks = true\ncodex_hooks = true', 'ready'],
    ['hooks = true', 'ready'],
    ['hooks = false', 'not_ready'],
    ['hooks = true\ncodex_hooks = false', 'not_ready'],
    ['hooks = false\ncodex_hooks = true', 'not_ready'],
    ['hooks = true\ncodex_hooks = "true"', 'not_ready'],
  ])('Codex設定の有効判定と明示falseを保持する: %s', (features, expected) => {
    const fixture = isolated(); readyFactory(fixture);
    const configPath = join(fixture.codexHome, 'config.toml');
    const config = `[features]\n${features}\n`;
    writeFileSync(configPath, config);
    const before = statSync(configPath).mtimeMs;
    const result = run(['factory-diagnostics', '--json'], fixture.env);
    expect(json(result).connectors.codex.status).toBe(expected);
    expect(result.status).toBe(expected === 'ready' ? 0 : 1);
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    expect(statSync(configPath).mtimeMs).toBe(before);
  });

  it('keeps a missing isolated home read-only and emits one JSON diagnostic with non-ready exit', () => {
    const fixture = isolated(); const db = join(fixture.caveatHome, 'index', 'caveat.db');
    const result = run(['factory-diagnostics', '--json'], fixture.env);
    expect(result.status).toBe(1); const output = json(result);
    expect(output).toMatchObject({ schema: 'caveat.native_factory_diagnostics.v1', overall: { status: 'not_ready' } });
    expect(existsSync(db)).toBe(false); expect(existsSync(join(fixture.caveatHome, 'own'))).toBe(false);
  });

  it('keeps prepared ready DB/config/git mtimes unchanged and exposes runtime JSON lifecycle plus negative arguments', () => {
    const fixture = isolated(); readyFactory(fixture); const dbPath = join(fixture.caveatHome, 'index', 'caveat.db');
    const own = join(fixture.caveatHome, 'own');
    const config = runtimeErrorsConfigPath(fixture.env);
    const before = [statSync(dbPath).mtimeMs, statSync(config).mtimeMs, statSync(join(own, '.git')).mtimeMs];
    const diagnostic = run(['factory-diagnostics', '--json'], fixture.env); expect(diagnostic.status).toBe(0); const factory = json(diagnostic);
    expect(factory).toMatchObject({
      schema: 'caveat.native_factory_diagnostics.v1',
      overall: { status: 'ready' },
      connectors: { cursor: { compatibility_status: 'not_ready' } },
    });
    const requiredMissing = run(['factory-diagnostics', '--json', '--require-connector', 'cursor'], fixture.env);
    expect(requiredMissing.status).toBe(1);
    expect(json(requiredMissing)).toMatchObject({ schema: 'caveat.native_factory_diagnostics.v1', overall: { status: 'not_ready' } });
    readyCursor(fixture);
    const requiredReady = run(['factory-diagnostics', '--json', '--require-connector', 'cursor'], fixture.env);
    expect(requiredReady.status).toBe(0);
    expect(json(requiredReady)).toMatchObject({
      schema: 'caveat.native_factory_diagnostics.v1',
      overall: { status: 'ready' },
      connectors: { cursor: { compatibility_status: 'ready' } },
    });
    expect([statSync(dbPath).mtimeMs, statSync(config).mtimeMs, statSync(join(own, '.git')).mtimeMs]).toEqual(before);

    const recorded = recordRuntimeError('CAVEAT.DATABASE_OPEN_FAILED', { env: fixture.env, version: '0.16.3' });
    const snapshot = json(run(['runtime-errors', 'snapshot', '--json'], fixture.env));
    expect(snapshot).toMatchObject({ schema: 'caveat.runtime_errors.v1', product: 'caveat', diagnostics: { collection: 'enabled' } });
    const fingerprint = snapshot.runtime_errors[0].fingerprint as string; const cursor = snapshot.cursor.high_watermark as number;
    expect(json(run(['runtime-errors', 'ack', String(cursor), '--json'], fixture.env)).cursor.acknowledged_through).toBe(cursor);
    expect(json(run(['runtime-errors', 'resolve', fingerprint, '--json'], fixture.env)).resolutions[0].fingerprint).toBe(fingerprint);
    expect(json(run(['runtime-errors', 'reopen', fingerprint, '--json'], fixture.env)).runtime_errors[0].fingerprint).toBe(fingerprint);
    expect(json(run(['runtime-errors', 'compact', '--json'], fixture.env)).schema).toBe('caveat.runtime_errors.v1');
    expect(runtimeErrorsStatePath(fixture.env)).toContain(fixture.root); expect(recorded.status).toBe('recorded');
    expect(run(['runtime-errors', 'ack', '99', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['runtime-errors', 'ack', 'not-a-number', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['runtime-errors', 'resolve', 'nope', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['runtime-errors', 'snapshot', '--after-cursor', '99', '--json'], fixture.env).status).not.toBe(0);
    expect(run(['factory-diagnostics'], fixture.env).status).not.toBe(0);
    expect(run(['factory-diagnostics', '--json', '--require-connector', 'unknown'], fixture.env).status).not.toBe(0);
  });

  it('rejects lookalike DB and connector registrations instead of emitting false ready', () => {
    const fixture = isolated(); readyFactory(fixture); const dbPath = join(fixture.caveatHome, 'index', 'caveat.db');
    const db = new DatabaseSync(dbPath); db.exec("DROP TRIGGER entries_ai; DROP TRIGGER entries_ad; DROP TRIGGER entries_au; DROP TABLE entries_fts; CREATE VIRTUAL TABLE entries_fts USING fts5(garbage, content='entries', content_rowid='rowid', tokenize='trigram'); CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(garbage) VALUES ('insert'); END; CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts(entries_fts) VALUES('delete'); END; CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN INSERT INTO entries_fts(entries_fts) VALUES('delete'); INSERT INTO entries_fts(garbage) VALUES ('update'); END;"); db.close();
    const fakeDb = json(run(['factory-diagnostics', '--json'], fixture.env)); expect(fakeDb.database).toMatchObject({ status: 'not_ready', reason_code: 'schema_contract_mismatch' });

    const connectorFixture = isolated(); readyFactory(connectorFixture);
    writeFileSync(join(connectorFixture.home, '.claude.json'), JSON.stringify({ mcpServers: { caveat: { type: 'stdio', command: process.execPath, args: ['--disable-warning=ExperimentalWarning', cli, 'not-mcp-server'], env: {} } } }));
    writeFileSync(join(connectorFixture.codexHome, 'config.toml'), '[features]\nhooks = false\n');
    const fakeConnector = json(run(['factory-diagnostics', '--json'], connectorFixture.env));
    expect(fakeConnector.connectors.claude.mcp.status).toBe('not_ready'); expect(fakeConnector.connectors.codex.status).toBe('not_ready'); expect(fakeConnector.overall.status).toBe('not_ready');

    const partialCursorFixture = isolated(); readyFactory(partialCursorFixture); readyCursor(partialCursorFixture);
    const cursorPath = join(partialCursorFixture.home, '.cursor', 'hooks.json');
    const partialCursor = JSON.parse(readFileSync(cursorPath, 'utf8')) as { hooks: Record<string, unknown> };
    delete partialCursor.hooks.postToolUseFailure;
    writeFileSync(cursorPath, JSON.stringify(partialCursor));
    const cursorDiagnostic = run(['factory-diagnostics', '--json', '--require-connector', 'cursor'], partialCursorFixture.env);
    expect(cursorDiagnostic.status).toBe(1);
    expect(json(cursorDiagnostic)).toMatchObject({
      schema: 'caveat.native_factory_diagnostics.v1',
      overall: { status: 'not_ready' },
      connectors: {
        cursor: {
          compatibility_status: 'not_ready',
          hooks: { post_tool_use_failure: { status: 'not_ready', reason_code: 'not_installed' } },
        },
      },
    });

    readyCursor(partialCursorFixture);
    const wrongTimeout = JSON.parse(readFileSync(cursorPath, 'utf8')) as { hooks: { stop: Array<{ timeout: number }> } };
    wrongTimeout.hooks.stop[0]!.timeout = 9;
    writeFileSync(cursorPath, JSON.stringify(wrongTimeout));
    const wrongTimeoutDiagnostic = run(['factory-diagnostics', '--json', '--require-connector', 'cursor'], partialCursorFixture.env);
    expect(wrongTimeoutDiagnostic.status).toBe(1);
    expect(json(wrongTimeoutDiagnostic)).toMatchObject({
      overall: { status: 'not_ready' },
      connectors: { cursor: { compatibility_status: 'not_ready', hooks: { stop: { status: 'not_ready' } } } },
    });

    writeFileSync(cursorPath, '{');
    const malformedDefault = run(['factory-diagnostics', '--json'], partialCursorFixture.env);
    expect(malformedDefault.status).toBe(0);
    expect(json(malformedDefault)).toMatchObject({
      overall: { status: 'ready' },
      connectors: { cursor: { compatibility_status: 'unverified' } },
    });
    const malformedRequired = run(['factory-diagnostics', '--json', '--require-connector', 'cursor'], partialCursorFixture.env);
    expect(malformedRequired.status).toBe(1);
    expect(json(malformedRequired)).toMatchObject({
      overall: { status: 'unverified' },
      connectors: { cursor: { compatibility_status: 'unverified' } },
    });

    const legacyTimeoutFixture = isolated(); readyFactory(legacyTimeoutFixture);
    const legacyPath = join(legacyTimeoutFixture.codexHome, 'hooks.json');
    const legacyHooks = JSON.parse(readFileSync(legacyPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
    for (const entries of Object.values(legacyHooks.hooks)) for (const entry of entries) for (const hook of entry.hooks) {
      hook.timeoutSec = hook.timeout;
      delete hook.timeout;
    }
    writeFileSync(legacyPath, JSON.stringify(legacyHooks));
    const legacyTimeout = json(run(['factory-diagnostics', '--json'], legacyTimeoutFixture.env));
    expect(legacyTimeout.connectors.codex.status).toBe('not_ready');

    const executorFixture = isolated(); readyFactory(executorFixture); readyCursor(executorFixture);
    const fakeNode = join(executorFixture.root, 'not-node'); const fakeCli = join(executorFixture.root, 'caveat.js');
    writeFileSync(fakeNode, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); writeFileSync(fakeCli, '/* not Caveat */\n', { mode: 0o644 });
    writeFileSync(join(executorFixture.home, '.claude.json'), JSON.stringify({ mcpServers: { caveat: { type: 'stdio', command: fakeNode, args: ['--disable-warning=ExperimentalWarning', fakeCli, 'mcp-server'], env: {} } } }));
    writeFileSync(join(executorFixture.home, '.claude', 'settings.json'), JSON.stringify({ hooks: Object.fromEntries([['UserPromptSubmit', 'user-prompt-submit'], ['PostToolUse', 'post-tool-use'], ['PostToolUseFailure', 'post-tool-use'], ['Stop', 'stop']].map(([event, subcommand]) => [event, [{ hooks: [{ command: `${fakeNode} ${fakeCli} hook ${subcommand}` }] }]])) }));
    writeFileSync(join(executorFixture.codexHome, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries([['UserPromptSubmit', 'user-prompt-submit'], ['PostToolUse', 'post-tool-use'], ['Stop', 'stop']].map(([event, subcommand]) => [event, [{ hooks: [{ command: `${fakeNode} ${fakeCli} codex-hook ${subcommand}` }] }]])) }));
    writeFileSync(join(executorFixture.home, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: Object.fromEntries([['beforeSubmitPrompt', 'user-prompt-submit'], ['postToolUse', 'post-tool-use'], ['postToolUseFailure', 'post-tool-use'], ['stop', 'stop']].map(([event, subcommand]) => [event, [{ command: `${fakeNode} ${fakeCli} cursor-hook ${subcommand}`, timeout: 10 }]])) }));
    const fakeExecutor = json(run(['factory-diagnostics', '--json', '--require-connector', 'cursor'], executorFixture.env));
    expect(fakeExecutor.connectors.claude.status).toBe('not_ready'); expect(fakeExecutor.connectors.codex.status).toBe('not_ready'); expect(fakeExecutor.connectors.cursor.compatibility_status).toBe('not_ready'); expect(fakeExecutor.overall.status).toBe('not_ready');

    if (process.platform === 'win32') {
      const unquotedWindows = isolated(); readyFactory(unquotedWindows);
      const settingsPath = join(unquotedWindows.home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
      for (const entries of Object.values(settings.hooks)) for (const entry of entries) for (const hook of entry.hooks) {
        hook.command = hook.command.replace(`"${cli}"`, cli);
      }
      writeFileSync(settingsPath, JSON.stringify(settings));
      const legacy = json(run(['factory-diagnostics', '--json'], unquotedWindows.env));
      expect(legacy.connectors.claude.status).toBe('not_ready');
      expect(legacy.overall.status).toBe('not_ready');
    }
  });

  it('does not report own sync ready for dirty, remotely-behind, or unreachable worktrees', () => {
    const dirty = isolated(); readyFactory(dirty); writeFileSync(join(dirty.caveatHome, 'own', 'dirty.md'), 'uncommitted\n');
    expect(json(run(['factory-diagnostics', '--json'], dirty.env)).sync).toMatchObject({ status: 'not_ready', reason_code: 'worktree_dirty' });

    const behind = isolated(); readyFactory(behind); const remote = join(behind.root, 'remote.git'); const writer = join(behind.root, 'writer');
    execFileSync('git', ['clone', '--branch', 'main', remote, writer], { stdio: 'pipe' }); execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: writer }); execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: writer });
    writeFileSync(join(writer, 'remote.md'), 'remote advance\n'); execFileSync('git', ['add', '.'], { cwd: writer }); execFileSync('git', ['commit', '-m', 'remote advance'], { cwd: writer, stdio: 'pipe' }); execFileSync('git', ['push'], { cwd: writer, stdio: 'pipe' });
    execFileSync('git', ['fetch', 'origin'], { cwd: join(behind.caveatHome, 'own'), stdio: 'pipe' });
    expect(json(run(['factory-diagnostics', '--json'], behind.env)).sync).toMatchObject({ status: 'not_ready', reason_code: 'remote_mismatch' });

    const unreachable = isolated(); readyFactory(unreachable); const own = join(unreachable.caveatHome, 'own');
    execFileSync('git', ['remote', 'set-url', 'origin', join(unreachable.root, 'missing-remote.git')], { cwd: own });
    expect(json(run(['factory-diagnostics', '--json'], unreachable.env)).sync.status).not.toBe('ready');
  });
});
