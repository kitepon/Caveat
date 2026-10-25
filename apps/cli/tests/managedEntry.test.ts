import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageManagedDeployment, activateManagedDeployment, managedDeploymentPaths } from '@caveat/core';
import { installMcpClient } from '../src/mcpInstall.js';
import { installClaudeIntegration } from '../src/claudeInstall.js';
import { installCodexHooks } from '../src/codexHookInstall.js';
import { installCursorHooks } from '../src/cursorInstall.js';
import { buildContext } from '../src/context.js';
import { runInit } from '../src/commands/init.js';
import { parse } from 'smol-toml';

describe('shipped stable entry and normal host installers', () => {
  it('dispatches both releases and rollback with fixed argv, entry bytes and four-client/hook definitions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-managed-bin-'));
    const userHome = join(root, 'profile'); mkdirSync(userHome, { mode: 0o700 });
    const options = { userHome };
    const built = resolve('dist');
    const source = (version: string) => {
      const dir = join(root, version); mkdirSync(join(dir, 'dist'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'caveat-cli', version, type: 'module', bin: { caveat: 'dist/caveat.js' } }));
      writeFileSync(join(dir, 'dist', 'caveat.js'), readFileSync(resolve('src/bootstrap.mjs')));
      writeFileSync(join(dir, 'dist', 'index.js'), `console.log(JSON.stringify({version:${JSON.stringify(version)},entry:process.argv[1],args:process.argv.slice(2)}));\n`);
      for (const name of ['stable-entry.mjs', 'managed-deployment.js']) writeFileSync(join(dir, 'dist', name), readFileSync(join(built, name)));
      return dir;
    };
    try {
      const a = stageManagedDeployment(source('1.0.0'), options), b = stageManagedDeployment(source('1.0.1'), options);
      const paths = managedDeploymentPaths(userHome), logger = { info() {}, warn() {}, error() {} };
      const configs = join(root, 'configs'); mkdirSync(configs, { mode: 0o700 });
      const install = () => {
        for (const client of ['claude', 'codex', 'grok', 'cursor'] as const) installMcpClient({ client, configPath: join(configs, client + (client === 'codex' || client === 'grok' ? '.toml' : '.json')), nodePath: process.execPath, cliScriptPath: paths.launcher, dryRun: false });
        installClaudeIntegration({ claudeDir: join(configs, 'claude'), mcpConfigPath: join(configs, 'claude-mcp.json'), cliScriptPath: paths.launcher, nodePath: process.execPath, dryRun: false, logger });
        installCodexHooks({ codexHome: join(configs, 'codex'), cliScriptPath: paths.launcher, nodePath: process.execPath, dryRun: false, logger });
        installCursorHooks({ cursorDir: join(configs, 'cursor'), cliScriptPath: paths.launcher, nodePath: process.execPath, dryRun: false, logger });
      };
      const settings = ['claude.json','codex.toml','grok.toml','cursor.json','claude/settings.json','claude-mcp.json','codex/config.toml','codex/hooks.json','cursor/hooks.json'];
      const snapshot = () => settings.map(f => readFileSync(join(configs, f), 'utf8'));
      const entry = readFileSync(paths.launcher), runtime = readFileSync(paths.runtime);
      let baseline: string[] | undefined;
      for (const [release, version] of [[a.release, '1.0.0'], [b.release, '1.0.1'], [a.release, '1.0.0']]) {
        activateManagedDeployment(release!, options);
        const run = spawnSync(process.execPath, [paths.launcher, 'one value', '日本語'], { encoding: 'utf8', timeout: 5000 });
        expect(run.status, run.stderr).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual({ version, entry: paths.launcher, args: ['one value', '日本語'] });
        install(); baseline ??= snapshot(); expect(snapshot()).toEqual(baseline);
        expect(readFileSync(paths.launcher)).toEqual(entry); expect(readFileSync(paths.runtime)).toEqual(runtime);
      }
      // The public init entry resolves the selected path once in its own profile;
      // the low-level config writers still honor their explicit caller paths.
      for (const [key,dir] of [['CLAUDE_CONFIG_DIR','.claude'],['CODEX_HOME','.codex'],['GROK_HOME','.grok'],['CURSOR_HOME','.cursor']]) {
        mkdirSync(join(userHome,dir!),{recursive:true});vi.stubEnv(key!,join(userHome,dir!));
      }
      const ctx=buildContext(logger,{userHome,caveatHome:join(userHome,'.caveat')});
      const initialize=()=>runInit(ctx,{skipClaude:false,dryRun:false,yes:true},{isTty:()=>false,codexAvailable:()=>true});
      await initialize();
      expect(JSON.parse(readFileSync(join(userHome,'.claude/.claude.json'),'utf8')).mcpServers.caveat.args[1]).toBe(paths.launcher);
      expect(parse(readFileSync(join(userHome,'.codex/config.toml'),'utf8')).mcp_servers).toMatchObject({caveat:{args:['--disable-warning=ExperimentalWarning',paths.launcher,'mcp-server']}});
      const normalFiles=['.claude/settings.json','.claude/.claude.json','.codex/hooks.json','.codex/config.toml','.grok/config.toml','.cursor/hooks.json','.cursor/mcp.json'];
      const normalSnapshot=()=>normalFiles.map(f=>readFileSync(join(userHome,f),'utf8'));
      const normalBefore=normalSnapshot();
      activateManagedDeployment(b.release,options);await initialize();expect(normalSnapshot()).toEqual(normalBefore);
      // A damaged pointer never dispatches an arbitrary path or writes a registration.
      const before = snapshot(); writeFileSync(paths.pointer, '{invalid');
      const rejected = spawnSync(process.execPath, [paths.launcher], { encoding: 'utf8', timeout: 5000 });
      expect(rejected.status).toBe(1); expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('managed deployment is unavailable'); expect(snapshot()).toEqual(before);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  }, 90000);
});
