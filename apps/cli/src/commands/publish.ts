import { publishOwn, PublishScanError, writeUserConfigPatch } from '@caveat/core';
import type { CliContext } from '../context.js';
import { askOnce, defaultGitHubRepoUrl, runGh, type GhRunner } from '../ghSetup.js';
const HTTPS_TARGET_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/;
const SCP_TARGET_RE = /^git@github\.com:[^/]+\/[^/]+?(?:\.git)?$/;

export interface PublishCmdOptions { init?: string; dryRun: boolean; yes: boolean; allow?: string[]; save?: boolean; }
export interface PublishCmdDependencies {
  ghRunner?: GhRunner;
  isTty?: () => boolean;
  confirm?: (question: string) => boolean;
}

export function validatePublishTarget(url: string): string {
  if (!HTTPS_TARGET_RE.test(url) && !SCP_TARGET_RE.test(url)) throw new Error('invalid publish target: use https://github.com/<org>/<repo>(.git) or git@github.com:<org>/<repo>(.git)');
  return url;
}

async function defaultPublicRepoUrl(opts: PublishCmdOptions, deps: Pick<Required<PublishCmdDependencies>, 'ghRunner' | 'isTty' | 'confirm'>): Promise<string> {
  return defaultGitHubRepoUrl({
    repositoryName: 'Caveat-Public',
    visibility: 'public',
    yes: opts.yes,
    retryCommand: 'caveat publish --init <url>',
    ...deps,
  });
}

export async function runPublish(ctx: CliContext, opts: PublishCmdOptions, dependencies: PublishCmdDependencies = {}): Promise<void> {
  try {
    const ghRunner = dependencies.ghRunner ?? runGh;
    const isTty = dependencies.isTty ?? (() => Boolean(process.stdin.isTTY));
    const confirm = dependencies.confirm ?? askOnce;
    let target = ctx.config.publishTarget;
    if (opts.init !== undefined) {
      target = validatePublishTarget(opts.init);
      writeUserConfigPatch(ctx.userConfigPath, { publishTarget: target });
    }
    if (!target) {
      target = await defaultPublicRepoUrl(opts, { ghRunner, isTty, confirm });
      writeUserConfigPatch(ctx.userConfigPath, { publishTarget: target });
    }
    const result = await publishOwn({
      paths: ctx.paths,
      config: { ...ctx.config, publishTarget: target },
      logger: ctx.logger,
      confirmImpl: confirm,
      isTty,
      dryRun: opts.dryRun,
      yes: opts.yes,
      allow: opts.allow,
      saveAllow: opts.save,
    });
    if (result.dryRun) ctx.logger.info(`[dry-run] ${result.fileCount} public entry(ies) ready to publish`);
    else if (result.changed) ctx.logger.info(`published ${result.fileCount} public entry(ies)`);
  } catch (err) {
    if (err instanceof PublishScanError) {
      for (const finding of err.findings) {
        ctx.logger.error(`${finding.relPath}:${finding.line} ${finding.rule} ${finding.excerpt}`);
        ctx.logger.error(`  --allow ${finding.matchDigest}`);
      }
      process.exitCode = 1;
      return;
    }
    ctx.logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
