import { spawnSync } from 'node:child_process';
import { readSync } from 'node:fs';

export interface GhRunResult { status: number | null; stdout: string; stderr: string; }
export type GhRunner = (args: string[]) => GhRunResult;

/** Expected setup refusal/cancellation; the command still reports failure. */
export class RepoSetupError extends Error {}

export function runGh(args: string[]): GhRunResult {
  const result = spawnSync('gh', args, { encoding: 'utf-8' });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '' };
}

export function commandError(result: GhRunResult, fallback: string): Error {
  return new RepoSetupError((result.stderr || result.stdout || fallback).trim());
}

export interface DefaultGitHubRepoOptions {
  repositoryName: 'Caveat-Private' | 'Caveat-Public';
  visibility: 'private' | 'public';
  yes: boolean;
  retryCommand: string;
  ghRunner: GhRunner;
  isTty: () => boolean;
  confirm: (question: string) => boolean;
}

/** Resolve (and, with consent, create) Caveat's conventional GitHub repository. */
export function defaultGitHubRepoUrl(opts: DefaultGitHubRepoOptions): string {
  const version = opts.ghRunner(['--version']);
  if (version.status !== 0) {
    throw new RepoSetupError(
      `gh is not available. create a ${opts.visibility} repository named ${opts.repositoryName} on GitHub, then run:\n` +
      `  ${opts.retryCommand}\n` +
      `  # or install gh and retry`,
    );
  }

  const user = opts.ghRunner(['api', 'user', '-q', '.login']);
  if (user.status !== 0 || !user.stdout.trim()) {
    throw new RepoSetupError(`gh is not authenticated; run \`gh auth login\`, then retry \`${opts.retryCommand}\``);
  }

  const login = user.stdout.trim();
  const setupGit = opts.ghRunner(['auth', 'setup-git']);
  if (setupGit.status !== 0) {
    throw commandError(setupGit, 'gh auth setup-git failed');
  }
  const qualifiedName = `${login}/${opts.repositoryName}`;
  const view = opts.ghRunner(['repo', 'view', qualifiedName]);
  if (view.status !== 0) {
    const question = `create ${opts.visibility} repo github.com/${qualifiedName}? [y/N]`;
    if (!opts.yes) {
      if (!opts.isTty()) {
        throw new RepoSetupError(`${question}; rerun with --yes to approve non-interactively`);
      }
      if (!opts.confirm(question)) throw new RepoSetupError(`${opts.visibility} repository creation cancelled`);
    }
    const create = opts.ghRunner(['repo', 'create', opts.repositoryName, `--${opts.visibility}`]);
    if (create.status !== 0) throw commandError(create, 'gh repo create failed');
  }
  return `https://github.com/${qualifiedName}.git`;
}

export function askOnce(question: string): boolean {
  process.stdout.write(`${question} `);
  const buf = Buffer.alloc(256);
  const bytes = readSync(0, buf, 0, buf.length, null);
  return /^(?:y|yes)$/i.test(buf.toString('utf-8', 0, bytes).trim());
}
