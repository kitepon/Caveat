import { observeRuntimeError, resetAutoSyncFailureState, syncOwn, initOwnSync, SyncError, SyncRemoteError, SyncRecoveryError } from '@caveat/core';
import type { CliContext } from '../context.js';
import { CAVEAT_VERSION } from '../version.js';
import { askOnce, defaultGitHubRepoUrl, runGh, RepoSetupError, type GhRunner } from '../ghSetup.js';

export interface SyncCmdOptions {
  init?: boolean | string;
  repo?: string;
  dryRun: boolean;
  trustRemotePrivate: boolean;
  yes: boolean;
}

export interface SyncCmdDependencies {
  ghRunner?: GhRunner;
  isTty?: () => boolean;
  confirm?: (question: string) => boolean;
}

async function defaultPrivateRepoUrl(
  opts: SyncCmdOptions,
  deps: Required<Pick<SyncCmdDependencies, 'ghRunner' | 'isTty' | 'confirm'>>,
): Promise<string> {
  return defaultGitHubRepoUrl({
    repositoryName: 'Caveat-Private',
    visibility: 'private',
    yes: opts.yes,
    retryCommand: 'caveat sync --init <url>',
    ...deps,
  });
}

export async function runSync(
  ctx: CliContext,
  opts: SyncCmdOptions,
  dependencies: SyncCmdDependencies = {},
): Promise<void> {
  if (opts.repo && (opts.init === undefined || opts.init === false)) {
    ctx.logger.error('--repo requires --init'); process.exitCode = 1; return;
  }
  try {
    const ghRunner = dependencies.ghRunner ?? runGh;
    const isTty = dependencies.isTty ?? (() => Boolean(process.stdin.isTTY));
    const confirm = dependencies.confirm ?? askOnce;
    const initValue = opts.init;
    if (initValue !== undefined && initValue !== false) {
      const url = opts.repo ?? (typeof initValue === 'string' ? initValue : await defaultPrivateRepoUrl(opts, { ghRunner, isTty, confirm }));
      const result = await initOwnSync({
        ownDir: ctx.paths.knowledgeRepo,
        url,
        caveatHome: ctx.caveatHome,
        paths: ctx.paths,
        logger: ctx.logger,
        trustRemotePrivate: opts.trustRemotePrivate,
      });
      ctx.logger.info(
        result.remoteWasEmpty
          ? `initialized private sync remote: ${url}`
          : `checked out existing private remote: ${url} (branch ${result.branch})`,
      );
      return;
    }
    const result = await syncOwn({
      ownDir: ctx.paths.knowledgeRepo,
      caveatHome: ctx.caveatHome,
      paths: ctx.paths,
      logger: ctx.logger,
      trustRemotePrivate: opts.trustRemotePrivate,
      dryRun: opts.dryRun,
    });
    if (result.dryRun) {
      ctx.logger.info(
        `[dry-run] ${result.changedFiles} local change(s) pending; remote ${result.pushUrls.join(', ')} (${result.probe.kind})`,
      );
    } else {
      const rebased = result.pulled ? ', rebased onto remote' : '';
      ctx.logger.info(`synced ${result.branch} → origin (${result.changedFiles} local change(s)${rebased})`);
      try {
        resetAutoSyncFailureState(ctx.caveatHome);
      } catch {
        // best-effort
      }
    }
  } catch (err) {
    // Safe refusals, cancellation and surfaced remote failures keep local input.
    // Unexpected failures and failed recovery still require a producer report.
    if (!(err instanceof RepoSetupError || err instanceof SyncError || err instanceof SyncRemoteError)) {
      observeRuntimeError('CAVEAT.SYNC_FAILED', { version: CAVEAT_VERSION,
        impact: err instanceof SyncRecoveryError ? 'recovery_failed' : 'operation_failed' });
      ctx.logger.warn('sync did not complete; cause and recovery require investigation');
    }
    if (err instanceof SyncRemoteError) ctx.logger.warn(`sync remote command failed (${err.phase}); cause unconfirmed; local input retained; retry checks remote state`);
    if (err instanceof SyncRecoveryError) ctx.logger.warn('sync recovery is unverified; do not retry before inspecting the rebase');
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error(message);
    process.exitCode = 1;
  }
}
