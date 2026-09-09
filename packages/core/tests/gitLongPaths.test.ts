import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createGit } from '../src/gitRuntime.js';

it.skipIf(process.platform !== 'win32')('Windowsで260文字を超えるentryを同期し、checkoutできる', async () => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-long-path-'));
  try {
    const own = join(root, 'own');
    mkdirSync(own);
    const git = createGit(own);
    await git.init();
    await git.addConfig('user.name', 'Caveat試験');
    await git.addConfig('user.email', 'test@example.invalid');
    const relative = `entries/misc/${'long-entry-'.repeat(19)}.md`;
    const entry = join(own, relative);
    expect(entry.length).toBeGreaterThan(260);
    mkdirSync(join(own, 'entries', 'misc'), { recursive: true });
    writeFileSync(entry, '長いパスの同期試験\n');
    expect(() => execFileSync('git', ['-C', own, '-c', 'core.longpaths=false', 'add', '--all'], { stdio: 'pipe' }))
      .toThrow(/Filename too long/);

    await git.add('--all');
    await git.commit('長いパスの試験');
    const checkout = join(root, 'checkout');
    await createGit().clone(own, checkout);
    expect(readFileSync(join(checkout, relative), 'utf8')).toBe('長いパスの同期試験\n');
    await expect(git.raw(['config', '--local', '--get', 'core.longpaths'])).resolves.toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 15_000);
