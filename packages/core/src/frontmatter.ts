import matter from 'gray-matter';
import { loadFrontmatter, EntryFrontmatterFormatError } from './frontmatterCodec.js';
import { ENTRY_LIMITS, assertUtf8Limit } from './entryConstraints.js';
import type { Frontmatter } from './types.js';

const yamlEngine = loadFrontmatter;

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  body: string;
  sections: Record<string, string>;
}

export function parseMarkdown(source: string, options: { allowOversizedBody?: boolean } = {}): ParsedMarkdown {
  if (!options.allowOversizedBody) assertUtf8Limit(source, 'entry_markdown', ENTRY_LIMITS.markdown);
  const normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (normalized.startsWith('---') && normalized[3] !== '-') {
    const language = matter.language(normalized).name.toLowerCase();
    if (language && language !== 'yaml' && language !== 'yml') throw new EntryFrontmatterFormatError();
  }
  const parsed = matter(source, { engines: { yaml: yamlEngine } });
  return {
    frontmatter: parsed.data as Frontmatter,
    body: parsed.content,
    sections: extractSections(parsed.content),
  };
}

export function extractSections(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let heading: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (heading !== null) result[heading] = buf.join('\n').trim();
      heading = m[1]!.trim();
      buf = [];
    } else if (heading !== null) {
      buf.push(line);
    }
  }
  if (heading !== null) result[heading] = buf.join('\n').trim();
  return result;
}

/**
 * Split an entry into the two role-text buckets used by the surface gate:
 *  - topical: title + tag labels + environment values. A token that appears
 *    here is "naming the topic" (固有名詞・カテゴリ).
 *  - symptom: the `## Symptom` section body. A token that appears here is
 *    "describing the failure mode" (現象の語彙).
 *
 * Inputs are accepted in the wire form used by the indexer: tags as a
 * JSON-stringified array, frontmatter as a JSON string. Malformed JSON is
 * tolerated — a parse failure means that source contributes nothing to the
 * role text. The body is the entry's markdown body (post-frontmatter) so
 * extractSections can locate `## Symptom`.
 */
export function deriveRoleTexts(input: {
  title: string;
  body: string;
  tags?: string | null;
  frontmatter_json?: string | null;
}): { topical: string; symptom: string } {
  const tagLabels: string[] = [];
  if (input.tags) {
    try {
      const parsed: unknown = JSON.parse(input.tags);
      if (Array.isArray(parsed)) {
        for (const t of parsed) if (typeof t === 'string') tagLabels.push(t);
      }
    } catch {
      // malformed tags JSON — skip
    }
  }

  const envValues: string[] = [];
  if (input.frontmatter_json) {
    try {
      const fm = JSON.parse(input.frontmatter_json) as { environment?: unknown };
      if (fm && typeof fm.environment === 'object' && fm.environment !== null) {
        for (const v of Object.values(fm.environment as Record<string, unknown>)) {
          if (typeof v === 'string') envValues.push(v);
          else if (typeof v === 'number' || typeof v === 'boolean') envValues.push(String(v));
        }
      }
    } catch {
      // malformed frontmatter — skip
    }
  }

  const topical = [input.title, ...tagLabels, ...envValues].join('\n');

  const sections = extractSections(input.body);
  const symptomKey = Object.keys(sections).find(
    (k) => k.trim().toLowerCase() === 'symptom',
  );
  const symptom = symptomKey ? (sections[symptomKey] ?? '') : '';

  return { topical, symptom };
}
