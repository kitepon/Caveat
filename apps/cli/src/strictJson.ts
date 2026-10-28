import { TextDecoder } from 'node:util';
import { visit } from 'jsonc-parser';

/** Strict, bounded JSON. The parser library supplies tokenization and nesting events. */
export function strictJson(bytes: Uint8Array, limit = 16384): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) throw new Error('json_budget');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const objects: Set<string>[] = [];
  let depth = 0, invalid = false;
  visit(text, {
    onObjectBegin() { if (++depth > 32) throw new Error('json_depth'); objects.push(new Set()); },
    onObjectProperty(key) { const keys = objects.at(-1)!; if (keys.has(key)) invalid = true; keys.add(key); },
    onObjectEnd() { objects.pop(); depth--; },
    onArrayBegin() { if (++depth > 32) throw new Error('json_depth'); },
    onArrayEnd() { depth--; },
    onError() { invalid = true; },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (invalid || depth !== 0 || objects.length !== 0) throw new Error('json_invalid');
  return JSON.parse(text);
}
