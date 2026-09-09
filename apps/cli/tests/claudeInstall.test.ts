import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@caveat/core';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
} from '../src/claudeInstall.js';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

interface Fx {
  root: string;
  claudeDir: string;
  settingsPath: string;
  cliScriptPath: string;
  nodePath: string;
}

function makeFx(): Fx {
  const root = mkdtempSync(join(tmpdir(), 'caveat-install-'));
  const claudeDir = join(root, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  return {
    root,
    claudeDir,
    settingsPath: join(claudeDir, 'settings.json'),
    cliScriptPath: 'C:/fake/dist/index.js',
    nodePath: 'C:/fake/node.exe',
  };
}

function cleanup(fx: Fx): void {
  rmSync(fx.root, { recursive: true, force: true });
}

function findBackup(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).find((f) => f.startsWith('settings.json.caveat-backup-'));
}

describe('installClaudeIntegration (hooks only — MCP spawn tolerated)', () => {
  let fx: Fx;
  beforeEach(() => {
    fx = makeFx();
  });
  afterEach(() => {
    cleanup(fx);
  });

  it('creates settings.json with Claude hook events when none exists', () => {
    const result = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(result.hooks.userPromptSubmit).toBe('added');
    expect(result.hooks.postToolUse).toBe('added');
    expect(result.hooks.postToolUseFailure).toBe('added');
    expect(result.hooks.stop).toBe('added');

    const raw = readFileSync(fx.settingsPath, 'utf-8');
    const settings = JSON.parse(raw) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toContain(
      'hook user-prompt-submit',
    );
    expect(settings.hooks.PostToolUse[0]?.hooks[0]?.command).toContain(
      'hook post-tool-use',
    );
    expect(settings.hooks.PostToolUseFailure[0]?.hooks[0]?.command).toContain(
      'hook post-tool-use',
    );
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain('hook stop');
  });

  it('quotes Windows backslash paths even when they contain no spaces', () => {
    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: 'C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\caveat-cli\\dist\\caveat.js',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\caveat-cli\\dist\\caveat.js" hook user-prompt-submit',
    );
  });

  it('migrates an unquoted Windows hook and preserves its environment prefix', () => {
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const cliScriptPath = 'C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\caveat-cli\\dist\\caveat.js';
    writeFileSync(
      fx.settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `CAVEAT_HOOK_CODEX_SIDECAR=auto "${nodePath}" ${cliScriptPath} hook stop` }] }],
        },
      }),
      'utf-8',
    );

    const result = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath,
      nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });

    expect(result.hooks.stop).toBe('added');
    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(
      `CAVEAT_HOOK_CODEX_SIDECAR=auto "${nodePath}" "${cliScriptPath}" hook stop`,
    );
  });

  it('preserves existing hooks when adding caveat hooks', () => {
    writeFileSync(
      fx.settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'throughline prompt-submit' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      'throughline prompt-submit',
    );
    expect(settings.hooks.UserPromptSubmit[1]?.hooks[0]?.command).toContain(
      'hook user-prompt-submit',
    );
    expect(findBackup(fx.claudeDir)).toBeDefined();
  });

  it('is idempotent — second install does not duplicate hooks', () => {
    const first = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(first.hooks.userPromptSubmit).toBe('added');

    const second = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(second.hooks.userPromptSubmit).toBe('unchanged');
    expect(second.hooks.stop).toBe('unchanged');

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUseFailure).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('updates existing Caveat hooks when the installed node path changes', () => {
    writeFileSync(
      fx.settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: '/opt/homebrew/Cellar/node/26.0.0/bin/node /opt/homebrew/bin/caveat hook stop',
                  },
                ],
              },
              { hooks: [{ type: 'command', command: 'node "/pkg/bin/spotter.mjs" hook stop' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: '/opt/homebrew/bin/caveat',
      nodePath: '/opt/homebrew/bin/node',
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(result.hooks.stop).toBe('added');

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toBe(
      '/opt/homebrew/bin/node /opt/homebrew/bin/caveat hook stop',
    );
    expect(settings.hooks.Stop[1]?.hooks[0]?.command).toBe(
      'node "/pkg/bin/spotter.mjs" hook stop',
    );
  });

  it('treats env-prefixed caveat hooks as already installed', () => {
    const stopCmd = 'C:/fake/node.exe C:/fake/dist/index.js hook stop';
    const postToolUseCmd = 'C:/fake/node.exe C:/fake/dist/index.js hook post-tool-use';
    writeFileSync(
      fx.settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `CAVEAT_HOOK_CODEX_SIDECAR=auto ${stopCmd}`,
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `CAVEAT_HOOK_CODEX_SIDECAR=auto ${postToolUseCmd}`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(result.hooks.stop).toBe('unchanged');
    expect(result.hooks.postToolUse).toBe('unchanged');
    expect(result.hooks.postToolUseFailure).toBe('added');

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUseFailure).toHaveLength(1);
    expect(settings.hooks.PostToolUseFailure[0]?.hooks[0]?.command).toBe(
      `CAVEAT_HOOK_CODEX_SIDECAR=auto ${postToolUseCmd}`,
    );
  });

  it('dry-run leaves settings.json untouched', () => {
    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: true,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(existsSync(fx.settingsPath)).toBe(false);
  });

  it('uninstall removes hooks that install added', () => {
    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    const result = uninstallClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(result.hooks.userPromptSubmit).toBe('added'); // marker: was removed
    expect(result.hooks.postToolUse).toBe('added');
    expect(result.hooks.postToolUseFailure).toBe('added');
    expect(result.hooks.stop).toBe('added');

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(0);
    expect(settings.hooks.PostToolUse).toHaveLength(0);
    expect(settings.hooks.PostToolUseFailure).toHaveLength(0);
    expect(settings.hooks.Stop).toHaveLength(0);
  });

  it('uninstall removes env-prefixed caveat hooks', () => {
    const stopCmd = 'C:/fake/node.exe C:/fake/dist/index.js hook stop';
    writeFileSync(
      fx.settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `CAVEAT_HOOK_CODEX_SIDECAR=auto ${stopCmd}`,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = uninstallClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    expect(result.hooks.stop).toBe('added');

    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.Stop).toHaveLength(0);
  });

  it('uninstall leaves unrelated hooks intact', () => {
    writeFileSync(
      fx.settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'throughline prompt-submit' }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    installClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    uninstallClaudeIntegration({
      claudeDir: fx.claudeDir,
      cliScriptPath: fx.cliScriptPath,
      nodePath: fx.nodePath,
      dryRun: false,
      logger: silentLogger,
      skipMcpRegistration: true,
    });
    const settings = JSON.parse(readFileSync(fx.settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command).toBe(
      'throughline prompt-submit',
    );
  });
});

describe('isCanonicalCaveatClaudeHookCommand', () => {
  it('rejects incomplete token candidates before canonical path checks', async () => {
    const { isCanonicalCaveatClaudeHookCommand } = await import('../src/claudeInstall.js');
    expect(isCanonicalCaveatClaudeHookCommand('/usr/bin/node hook stop', 'stop', '/usr/bin/node', '/tmp/caveat.js')).toBe(false);
    expect(isCanonicalCaveatClaudeHookCommand('/usr/bin/node /tmp/caveat.js hook', 'stop', '/usr/bin/node', '/tmp/caveat.js')).toBe(false);
  });

  it('accepts symlink-equivalent asset paths (stable bin path vs process.execPath)', async () => {
    const { isCanonicalCaveatClaudeHookCommand } = await import('../src/claudeInstall.js');
    const { symlinkSync, chmodSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'caveat-canon-'));
    try {
      const nodeReal = join(root, 'node-real');
      const cliReal = join(root, 'caveat.js');
      writeFileSync(nodeReal, '#!/bin/sh\n');
      chmodSync(nodeReal, 0o755);
      writeFileSync(cliReal, '// cli\n');
      const nodeLink = join(root, 'node');
      const cliLink = join(root, 'caveat');
      symlinkSync(nodeReal, nodeLink);
      symlinkSync(cliReal, cliLink);
      // installer は安定パス（symlink）を書き、診断は process.execPath（実体）を渡す。
      // realpath が一致する限り canonical として認める（0.17.6 の false negative の再現固定）。
      const command = process.platform === 'win32'
        ? `"${nodeLink}" "${cliLink}" hook stop`
        : `${nodeLink} ${cliLink} hook stop`;
      expect(
        isCanonicalCaveatClaudeHookCommand(command, 'stop', nodeReal, cliReal),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects non-canonical quoting for paths that need no quotes', async () => {
    const { isCanonicalCaveatClaudeHookCommand } = await import('../src/claudeInstall.js');
    const { chmodSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'caveat-canon-'));
    try {
      const nodeReal = join(root, 'node-real');
      const cliReal = join(root, 'caveat.js');
      writeFileSync(nodeReal, '#!/bin/sh\n');
      chmodSync(nodeReal, 0o755);
      writeFileSync(cliReal, '// cli\n');
      const command = `"${nodeReal}" ${cliReal} hook stop`;
      expect(
        isCanonicalCaveatClaudeHookCommand(command, 'stop', nodeReal, cliReal),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
