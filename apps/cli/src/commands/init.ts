import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  KNOWLEDGE_GITIGNORE,
  cleanupStalePendingDirs,
  computeEntriesDigest,
  createKeyserverKeyProvider,
  ensureUserConfig,
  initOwnSync,
  openDb,
  prewarmSealedKeys,
  reindexAllSources,
  syncOwn,
  writeUserConfigPatch,
  writeDigestMarker,
} from '@caveat/core';
import type { CliContext } from '../context.js';
import {
  installClaudeIntegration,
  uninstallClaudeIntegration,
  type ClaudeInstallResult,
} from '../claudeInstall.js';
import {
  detectCodexHookInstallation,
  installCodexHooks,
} from '../codexHookInstall.js';
import {
  detectCursorHookInstallation,
  installCursorHooks,
} from '../cursorInstall.js';
import { askOnce, defaultGitHubRepoUrl, runGh, type GhRunner } from '../ghSetup.js';
import { resolveHookNodePath } from '../nodePath.js';
import { installMcpClient } from '../mcpInstall.js';
import { resolveAgentConfigPaths } from '../installShared.js';
import { validatePublishTarget } from './publish.js';

export interface InitOptions {
  skipClaude: boolean;
  dryRun: boolean;
  /**
   * Stale-age threshold (days) for sweeping abandoned pending reminder
   * directories under `<caveatHome>/pending/`. Directories whose newest
   * entry's mtime is older than this are removed. Default 7. 0 collects
   * any dir whose mtime is strictly in the past.
   */
  pendingStaleDays?: number;
  sync?: boolean | string;
  publishTarget?: boolean | string;
  yes?: boolean;
  skipCodexHook?: boolean;
  skipCursorHook?: boolean;
}

export interface InitDependencies {
  ghRunner?: GhRunner;
  isTty?: () => boolean;
  confirm?: (question: string) => boolean;
  codexAvailable?: () => boolean;
  env?: NodeJS.ProcessEnv;
}

export async function runInit(
  ctx: CliContext,
  opts: InitOptions = { skipClaude: false, dryRun: false },
  dependencies: InitDependencies = {},
): Promise<void> {
  const isTty = dependencies.isTty ?? (() => Boolean(process.stdin.isTTY));
  const confirm = dependencies.confirm ?? askOnce;
  const ghRunner = dependencies.ghRunner ?? runGh;
  const env = dependencies.env ?? process.env;
  const { claudeDir, claudeMcp, codexHome, cursorDir, grokHome } = resolveAgentConfigPaths(ctx.userHome, env);
  const codexAvailable = (dependencies.codexAvailable ?? detectCodexAvailability)();
  let publishTarget = ctx.config.publishTarget;
  let codexHookState: 'installed' | 'partial' | 'not-installed' | 'skipped' = 'not-installed';
  let cursorHookState: 'installed' | 'partial' | 'not-installed' | 'skipped' = 'not-installed';

  if (!opts.dryRun) ensureUserConfig(ctx.userConfigPath);
  ctx.logger.info(`user config: ${ctx.userConfigPath}`);

  if (!existsSync(ctx.paths.knowledgeRepo)) {
    if (!opts.dryRun) {
      mkdirSync(ctx.paths.knowledgeRepo, { recursive: true });
      mkdirSync(ctx.paths.entriesDir, { recursive: true });
    }
    ctx.logger.info(`${opts.dryRun ? '[dry-run] would scaffold' : 'knowledge repo scaffolded'}: ${ctx.paths.knowledgeRepo}`);
  } else {
    ctx.logger.info(`knowledge repo: ${ctx.paths.knowledgeRepo}`);
  }

  if (!opts.dryRun) migrateLegacyCommunityDir(ctx);

  const gitignorePath = join(ctx.paths.knowledgeRepo, '.gitignore');
  if (!existsSync(gitignorePath)) {
    if (!opts.dryRun) writeFileSync(gitignorePath, KNOWLEDGE_GITIGNORE, 'utf-8');
    ctx.logger.info(`${opts.dryRun ? '[dry-run] would create .gitignore' : '.gitignore created'}: ${gitignorePath}`);
  }

  if (!opts.dryRun) {
    const dbDir = dirname(ctx.paths.dbPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    const keyProvider = createKeyserverKeyProvider({ caveatHome: ctx.caveatHome });
    const failures = await prewarmSealedKeys({ paths: ctx.paths, keyProvider });
    for (const failure of failures) {
      ctx.logger.warn(`${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}`);
    }
    const db = openDb({ path: ctx.paths.dbPath, logger: ctx.logger });
    try {
      reindexAllSources({ db, paths: ctx.paths, logger: ctx.logger, keyProvider });
      writeDigestMarker(ctx.caveatHome, computeEntriesDigest(ctx.paths));
    } finally {
      db.close();
    }
    ctx.logger.info(`db initialized: ${ctx.paths.dbPath}`);
  } else {
    ctx.logger.info(`[dry-run] db path: ${ctx.paths.dbPath}`);
  }

  const staleDays = opts.pendingStaleDays ?? 7;
  if (opts.dryRun) {
    ctx.logger.info(`[dry-run] would sweep pending dirs older than ${staleDays}d`);
  } else {
    const swept = cleanupStalePendingDirs(ctx.caveatHome, { staleDays });
    if (swept.removed.length > 0) {
      ctx.logger.info(
        `pending dirs swept: removed ${swept.removed.length} (kept ${swept.kept}, threshold ${staleDays}d)`,
      );
    }
  }

  ctx.logger.info(
    'tip: subscribe to a group repo with `caveat community add <github-url>`, then `caveat pull`.',
  );

  let syncRequested = opts.sync !== undefined && opts.sync !== false;
  let syncNudgeAccepted = false;
  if (opts.sync === undefined && !opts.yes && isTty()) {
    syncNudgeAccepted = confirm('private 同期を今すぐ設定する？ [y/N]');
    syncRequested = syncNudgeAccepted;
  }
  if (syncRequested) {
    try {
      if (opts.dryRun) {
        const target = typeof opts.sync === 'string' ? opts.sync : '<user>/Caveat-Private';
        ctx.logger.info(`[dry-run] would initialize private sync: ${target}`);
      } else {
        const ownGit = join(ctx.paths.knowledgeRepo, '.git');
        if (existsSync(ownGit)) {
          const remote = gitOutput(['-C', ctx.paths.knowledgeRepo, 'remote', 'get-url', 'origin']);
          const result = await syncOwn({
            ownDir: ctx.paths.knowledgeRepo,
            caveatHome: ctx.caveatHome,
            paths: ctx.paths,
            logger: ctx.logger,
            trustRemotePrivate: remote !== null && isFileRemote(remote),
          });
          const rebased = result.pulled ? ', rebased onto remote' : '';
          ctx.logger.info(`synced existing private remote: ${result.branch} (${result.changedFiles} local change(s)${rebased})`);
        } else {
          const url = typeof opts.sync === 'string'
            ? opts.sync
            : defaultGitHubRepoUrl({
                repositoryName: 'Caveat-Private',
                visibility: 'private',
                yes: (opts.yes ?? false) || syncNudgeAccepted,
                retryCommand: 'caveat init --sync <url>',
                ghRunner,
                isTty,
                confirm,
              });
          const result = await initOwnSync({
            ownDir: ctx.paths.knowledgeRepo,
            url,
            caveatHome: ctx.caveatHome,
            paths: ctx.paths,
            logger: ctx.logger,
            // file: remotes are governed by local filesystem permissions and have
            // no anonymous HTTP surface for the remote-visibility probe to inspect.
            trustRemotePrivate: isFileRemote(url),
          });
          ctx.logger.info(
            result.remoteWasEmpty
              ? `initialized private sync remote: ${url}`
              : `checked out existing private remote: ${url} (branch ${result.branch})`,
          );
        }
      }
    } catch (err) {
      throw new Error(`private sync setup failed: ${errorMessage(err)}`, { cause: err });
    }
  }

  let publishRequested = opts.publishTarget !== undefined && opts.publishTarget !== false;
  let publishNudgeAccepted = false;
  if (opts.publishTarget === undefined && !opts.yes && isTty()) {
    publishNudgeAccepted = confirm('公開 repo（封緘ミラー）も設定する？ [y/N]');
    publishRequested = publishNudgeAccepted;
  }
  if (publishRequested) {
    try {
      const requested = typeof opts.publishTarget === 'string'
        ? validatePublishTarget(opts.publishTarget)
        : publishTarget;
      const target = requested ?? (opts.dryRun
        ? '<user>/Caveat-Public'
        : defaultGitHubRepoUrl({
            repositoryName: 'Caveat-Public',
            visibility: 'public',
            yes: (opts.yes ?? false) || publishNudgeAccepted,
            retryCommand: 'caveat init --publish-target <url>',
            ghRunner,
            isTty,
            confirm,
          }));
      if (opts.dryRun) {
        ctx.logger.info(`[dry-run] would configure publish target: ${target}`);
        publishTarget = target;
      } else if (target === publishTarget) {
        ctx.logger.info(`publish target already configured: ${target}`);
      } else {
        writeUserConfigPatch(ctx.userConfigPath, { publishTarget: target });
        publishTarget = target;
        ctx.logger.info(`publish target configured: ${target}`);
      }
    } catch (err) {
      ctx.logger.warn(`publish target setup skipped: ${errorMessage(err)}`);
    }
  }

  if (opts.skipClaude) {
    ctx.logger.info('Claude Code integration skipped (--skip-claude)');
  } else {
    const cliScriptPath = process.argv[1];
    if (!cliScriptPath) {
      ctx.logger.warn('cannot determine CLI script path; skipping Claude integration');
    } else {
      const result = installClaudeIntegration({
        claudeDir,
        mcpConfigPath: claudeMcp,
        cliScriptPath,
        nodePath: resolveHookNodePath(),
        dryRun: opts.dryRun,
        logger: ctx.logger,
      });
      reportInstallResult(ctx, result, opts.dryRun);
      if (result.mcp.action === 'failed') {
        throw new Error(`mcp_setup_failed: Claude Code: ${result.mcp.detail}`);
      }
    }
  }

  if (opts.skipCodexHook) {
    codexHookState = 'skipped';
    ctx.logger.info('Codex hook integration skipped (--skip-codex-hook)');
  } else if (codexAvailable) {
    const cliScriptPath = process.argv[1];
    if (!cliScriptPath) {
      codexHookState = 'skipped';
      ctx.logger.warn('cannot determine CLI script path; skipping Codex hook integration');
    } else {
      const result = installCodexHooks({
        codexHome,
        cliScriptPath,
        nodePath: resolveHookNodePath(),
        dryRun: opts.dryRun,
        logger: ctx.logger,
      });
      if (result.feature === 'blocked') {
        codexHookState = 'skipped';
        ctx.logger.warn(
          `${result.blockedReason}; preserving explicit consent. Set \`hooks = true\` in ${join(codexHome, 'config.toml')}, then rerun \`caveat init\`.`,
        );
      } else if (opts.dryRun) {
        codexHookState = 'skipped';
        ctx.logger.info('[dry-run] would install Codex hooks');
      } else {
        codexHookState = detectCodexHookInstallation(codexHome).installation;
      }
    }
  }

  if (opts.skipCursorHook) {
    cursorHookState = 'skipped';
    ctx.logger.info('Cursor hook integration skipped (--skip-cursor-hook)');
  } else if (existsSync(cursorDir)) {
    const cliScriptPath = process.argv[1];
    if (!cliScriptPath) {
      cursorHookState = 'skipped';
      ctx.logger.warn('cannot determine CLI script path; skipping Cursor hook integration');
    } else {
      const result = installCursorHooks({
        cursorDir,
        cliScriptPath,
        nodePath: resolveHookNodePath(),
        dryRun: opts.dryRun,
        logger: ctx.logger,
      });
      if (opts.dryRun) {
        cursorHookState = 'skipped';
        ctx.logger.info('[dry-run] would install Cursor hooks');
      } else {
        cursorHookState = detectCursorHookInstallation(cursorDir).installation;
        ctx.logger.info(`Cursor beforeSubmitPrompt hook: ${result.hooks.beforeSubmitPrompt}`);
        ctx.logger.info(`Cursor postToolUse hook: ${result.hooks.postToolUse}`);
        ctx.logger.info(`Cursor stop hook: ${result.hooks.stop}`);
      }
    }
  }

  const cliScriptPath = process.argv[1];
  if (!cliScriptPath) throw new Error('mcp_setup_failed: CLIの実行パスを取得できません');
  for (const [client, configPath, available] of [
    ['codex', join(codexHome, 'config.toml'), codexAvailable || existsSync(codexHome)],
    ['grok', join(grokHome, 'config.toml'), existsSync(grokHome)],
    ['cursor', join(cursorDir, 'mcp.json'), existsSync(cursorDir)],
  ] as const) {
    if (!available) continue;
    const action = installMcpClient({ client, configPath, cliScriptPath, nodePath: resolveHookNodePath(), dryRun: opts.dryRun });
    ctx.logger.info(`${client} MCP: ${action}`);
  }
  reportEnvironmentSummary(ctx, publishTarget, codexHookState, cursorHookState, opts.dryRun);
}

function detectCodexAvailability(): boolean {
  // A command string plus shell:true resolves codex.cmd on Windows as well as codex on POSIX.
  const result = spawnSync('codex --version', {
    shell: true,
    encoding: 'utf-8',
    stdio: 'ignore',
  });
  return !result.error && result.status === 0;
}

function isFileRemote(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

function gitOutput(args: string[]): string | null {
  const result = spawnSync('git', args, { encoding: 'utf-8' });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : null;
}

function reportEnvironmentSummary(
  ctx: CliContext,
  publishTarget: string | null,
  codexHookState: 'installed' | 'partial' | 'not-installed' | 'skipped',
  cursorHookState: 'installed' | 'partial' | 'not-installed' | 'skipped',
  dryRun: boolean,
): void {
  const prefix = dryRun ? '[dry-run] would have ' : '';
  const isRepo = gitOutput(['-C', ctx.paths.knowledgeRepo, 'rev-parse', '--is-inside-work-tree']) === 'true';
  const remote = isRepo
    ? gitOutput(['-C', ctx.paths.knowledgeRepo, 'config', '--get', 'remote.origin.url'])
    : null;
  const communityCount = existsSync(ctx.paths.communityDir)
    ? readdirSync(ctx.paths.communityDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    : 0;
  ctx.logger.info(`${prefix}environment summary:`);
  ctx.logger.info(`  own git: ${isRepo ? 'repository' : 'not initialized'}`);
  ctx.logger.info(`  private remote: ${remote || 'not configured'}`);
  ctx.logger.info(`  publish target: ${publishTarget || 'not configured'}`);
  ctx.logger.info(`  community sources: ${communityCount}`);
  ctx.logger.info(`  codex hook: ${codexHookState}`);
  ctx.logger.info(`  cursor hook: ${cursorHookState}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * v0.6.1 の paths 修正で `community/` の位置が `<knowledgeRepo>/community/` から
 * `<caveatHome>/community/` に移った。既存インストールは旧位置に clone を持つので、
 * 1 回だけ自動で移す。現行位置が既に存在する場合は何もしない（冪等）。
 */
function migrateLegacyCommunityDir(ctx: CliContext): void {
  const legacy = join(ctx.paths.knowledgeRepo, 'community');
  const current = ctx.paths.communityDir;
  if (legacy === current) return;
  if (!existsSync(legacy)) return;
  if (existsSync(current)) {
    ctx.logger.warn(
      `legacy community dir still exists at ${legacy} — remove manually (new location in use)`,
    );
    return;
  }
  mkdirSync(current, { recursive: true });
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    renameSync(join(legacy, entry.name), join(current, entry.name));
  }
  try {
    rmdirSync(legacy);
  } catch {
    // legacy dir has leftover files we didn't touch — leave it
  }
  ctx.logger.info(`migrated legacy community/ → ${current}`);
}

export interface UninstallOptions {
  dryRun: boolean;
}

export function runUninstall(ctx: CliContext, opts: UninstallOptions): void {
  const cliScriptPath = process.argv[1];
  if (!cliScriptPath) {
    ctx.logger.error('cannot determine CLI script path');
    process.exit(1);
  }

  const { claudeDir, claudeMcp } = resolveAgentConfigPaths(ctx.userHome);
  const result = uninstallClaudeIntegration({
    claudeDir,
    mcpConfigPath: claudeMcp,
    cliScriptPath,
    nodePath: resolveHookNodePath(),
    dryRun: opts.dryRun,
    logger: ctx.logger,
  });

  if (result.mcp.action === 'failed') throw new Error(`mcp_uninstall_failed: Claude Code: ${result.mcp.detail}`);
  ctx.logger.info(
    `MCP: ${result.mcp.action}${result.mcp.detail ? ` (${result.mcp.detail})` : ''}`,
  );
  ctx.logger.info(
    `UserPromptSubmit hook: ${result.hooks.userPromptSubmit === 'added' ? 'removed' : 'not present'}`,
  );
  ctx.logger.info(
    `PostToolUse hook: ${result.hooks.postToolUse === 'added' ? 'removed' : 'not present'}`,
  );
  ctx.logger.info(
    `PostToolUseFailure hook: ${result.hooks.postToolUseFailure === 'added' ? 'removed' : 'not present'}`,
  );
  ctx.logger.info(
    `Stop hook: ${result.hooks.stop === 'added' ? 'removed' : 'not present'}`,
  );
  if (result.backupPath) {
    ctx.logger.info(`settings.json backed up: ${result.backupPath}`);
  }
}

function reportInstallResult(
  ctx: CliContext,
  result: ClaudeInstallResult,
  dryRun: boolean,
): void {
  const prefix = dryRun ? '[dry-run] ' : '';
  ctx.logger.info(
    `${prefix}MCP: ${result.mcp.action}${result.mcp.detail ? ` (${result.mcp.detail})` : ''}`,
  );
  ctx.logger.info(
    `${prefix}UserPromptSubmit hook: ${result.hooks.userPromptSubmit}`,
  );
  ctx.logger.info(`${prefix}PostToolUse hook: ${result.hooks.postToolUse}`);
  ctx.logger.info(
    `${prefix}PostToolUseFailure hook: ${result.hooks.postToolUseFailure}`,
  );
  ctx.logger.info(`${prefix}Stop hook: ${result.hooks.stop}`);
  if (result.backupPath) {
    ctx.logger.info(`settings.json backed up: ${result.backupPath}`);
  }
  if (!dryRun && result.mcp.action === 'registered') {
    ctx.logger.info('next: restart Claude Code, then try /mcp to see the caveat server');
  }
}
