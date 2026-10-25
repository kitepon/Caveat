import yaml from 'js-yaml';
import legacyInt from './vendor/yaml-4.1.1-int.js';
import legacyFloat from './vendor/yaml-4.1.1-float.js';
import { ENTRY_LIMITS, EntryInputConstraintError, assertFrontmatterGraph, assertUtf8Limit } from './entryConstraints.js';
export class EntryFrontmatterFormatError extends Error {
  constructor() { super('Caveat frontmatter requires the YAML codec'); this.name = 'EntryFrontmatterFormatError'; }
}
// Timestamp-shaped values remain strings, while the dumper quotes them.
const timestamp = (yaml as typeof yaml & { types: { timestamp: { resolve: (value: string) => boolean } } }).types.timestamp;
const dateString = new yaml.Type('tag:yaml.org,2002:str', { kind: 'scalar', resolve: timestamp.resolve, construct: (value: string) => value });
export const CAVEAT_YAML_SCHEMA = yaml.JSON_SCHEMA.extend({ implicit: [legacyInt, legacyFloat, dateString] });
export function loadFrontmatter(raw: string): object {
  assertUtf8Limit(raw, 'frontmatter', ENTRY_LIMITS.frontmatter);
  let value: unknown;
  try { value = yaml.load(raw, { schema: CAVEAT_YAML_SCHEMA, maxDepth: ENTRY_LIMITS.depth } as yaml.LoadOptions & { maxDepth: number }) ?? {}; }
  catch (error) {
    if (error instanceof yaml.YAMLException && /^nesting exceeded maxDepth \(/.test(error.reason ?? ''))
      throw new EntryInputConstraintError('frontmatter.parser_depth', ENTRY_LIMITS.depth, ENTRY_LIMITS.depth, 'depth', 'lower_bound', 'parser_max_depth');
    throw error;
  }
  assertFrontmatterGraph(value); return value as object;
}
export function dumpFrontmatter(value: object): string {
  assertFrontmatterGraph(value);
  const raw = yaml.dump(value, { schema: CAVEAT_YAML_SCHEMA, noRefs: true, lineWidth: -1 });
  assertUtf8Limit(raw, 'frontmatter', ENTRY_LIMITS.frontmatter);
  return raw;
}
