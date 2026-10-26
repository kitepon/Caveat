#!/usr/bin/env node
// Pre-commit gate: reject commits that stage any entries/**/*.md with
// `visibility: private` in frontmatter. Runs in the knowledge repo
// (e.g., caveats-kite) where entries are committed.
// Output contract: exit 0 on pass, exit 1 on block with stderr explanation.

import { execFileSync } from 'node:child_process';
import { findBlockedFiles } from '@caveat/core';

export { findBlockedFiles };

function listStagedMarkdown() {
  const raw = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', 'entries/**/*.md'],
    { encoding: 'utf-8' },
  );
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

function readStagedContent(path) {
  try {
    return execFileSync('git', ['show', `:${path}`], { encoding: 'utf-8' });
  } catch {
    return null;
  }
}

function printBlockMessage(blocked) {
  process.stderr.write('\n[caveat:pre-commit] commit blocked — private or uninspectable frontmatter must not be committed:\n');
  for (const path of blocked) {
    process.stderr.write(`  - ${path}\n`);
  }
  process.stderr.write(
    '\nFix one of:\n' +
      '  1. Make frontmatter inspectable and set `visibility: public`, OR\n' +
      '  2. Rename the file to *.private.md (gitignored), OR\n' +
      '  3. Unstage: git reset HEAD <path>\n',
  );
}

async function main() {
  let paths;
  try {
    paths = listStagedMarkdown();
  } catch (err) {
    // Not a git repo, or other git failure. Exit 0 to avoid blocking non-git flows.
    process.stderr.write(`[caveat:pre-commit] skipped: ${err?.message ?? err}\n`);
    process.exit(0);
  }

  if (paths.length === 0) {
    process.exit(0);
  }

  const stagedContents = [];
  for (const path of paths) {
    const content = readStagedContent(path);
    if (content !== null) {
      stagedContents.push({ path, content });
    }
  }

  const blocked = findBlockedFiles(stagedContents);
  if (blocked.length > 0) {
    printBlockMessage(blocked);
    process.exit(1);
  }
  process.exit(0);
}

const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
const thisPath = import.meta.url.startsWith('file://')
  ? import.meta.url.slice(7).replace(/^\/+([a-zA-Z]:)/, '$1')
  : '';
if (invokedPath && thisPath && invokedPath.toLowerCase() === thisPath.toLowerCase()) {
  main();
}
