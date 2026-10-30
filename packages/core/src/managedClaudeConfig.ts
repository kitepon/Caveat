import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type ClaudeConfigIdentity = { dev: string; ino: string };
/** Retain only file identity; process environments may contain credentials. */
export function claudeConfigIdentity(bytes: Buffer, namespaceRoot?: string): ClaudeConfigIdentity | null {
  try {
    assert.ok(bytes.length <= 1024 * 1024 && bytes.at(-1) === 0);
    let home: string | undefined, directory: string | undefined;
    for (const field of new TextDecoder('utf8', { fatal: true }).decode(bytes).split('\0')) {
      if (field.startsWith('HOME=')) { assert.equal(home, undefined); home = field.slice(5); }
      if (field.startsWith('CLAUDE_CONFIG_DIR=')) { assert.equal(directory, undefined); directory = field.slice(18); }
    }
    const base = directory || home; assert.ok(base && isAbsolute(base));
    const file = join(base, '.claude.json');
    const stat = statSync(namespaceRoot ? join(namespaceRoot, file) : file, { bigint: true });
    assert.ok(stat.isFile()); return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch { return null; }
}
