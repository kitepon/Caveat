import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dumpFrontmatter } from './frontmatterCodec.js';
import { ENTRY_LIMITS, assertUtf8Limit } from './entryConstraints.js';
import type { Frontmatter } from './types.js';

export interface BuiltEntry {
  content: string;
  body: string;
}

export function buildEntry(frontmatter: Frontmatter, sections: Record<string, string>): BuiltEntry {
  const bodyParts: string[] = [];
  for (const [heading, content] of Object.entries(sections)) {
    if (content === undefined) continue;
    bodyParts.push(`## ${heading}\n\n${content.trim()}`);
  }
  const body = bodyParts.join('\n\n');
  const yamlStr = dumpFrontmatter(frontmatter);
  const content = `---\n${yamlStr}---\n\n${body}${body ? '\n' : ''}`;
  assertUtf8Limit(content, 'entry_markdown', ENTRY_LIMITS.markdown);
  return { content, body };
}

export function writeEntryFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}
