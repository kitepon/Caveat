import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigIdentity } from '../src/managedClaudeConfig.js';
it('uses HOME, config-dir precedence, actual file identity and no environment output', () => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-config-'));
  try {
    const home = join(root, 'home'), other = join(root, 'other'); mkdirSync(home); mkdirSync(other);
    writeFileSync(join(home, '.claude.json'), '{}'); writeFileSync(join(other, '.claude.json'), '{}');
    const identity = (file: string) => { const s = statSync(file, { bigint: true }); return { dev: String(s.dev), ino: String(s.ino) }; };
    expect(claudeConfigIdentity(Buffer.from('HOME=' + home + '\0SECRET=hidden\0'))).toEqual(identity(join(home, '.claude.json')));
    expect(claudeConfigIdentity(Buffer.from('HOME=' + home + '\0CLAUDE_CONFIG_DIR=' + other + '\0'))).toEqual(identity(join(other, '.claude.json')));
    expect(claudeConfigIdentity(Buffer.from('HOME=relative\0'))).toBeNull();
    expect(claudeConfigIdentity(Buffer.from('HOME=' + home))).toBeNull();
    expect(claudeConfigIdentity(Buffer.from('HOME=' + home + '\0HOME=' + other + '\0'))).toBeNull();
    if (process.platform !== 'win32') {
      symlinkSync(home, join(root, 'alias'));
      expect(claudeConfigIdentity(Buffer.from('HOME=' + join(root, 'alias') + '\0'))).toEqual(identity(join(home, '.claude.json')));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
