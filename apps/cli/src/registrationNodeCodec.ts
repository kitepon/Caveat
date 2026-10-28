import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseTree, findNodeAtLocation } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { strictJson } from './strictJson.js';
import { sameTomlValue } from './mcpInstall.js';
import { quoteCommandPath } from './installShared.js';

export type RegistrationNodeTarget = { path: (string | number)[]; kind: 'mcp' | 'hook'; suffix: string;
  beforeCommandSha256: string; proposedCommandSha256: string; argsSha256?: string };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const command = (target: RegistrationNodeTarget, node: string) => target.kind === 'mcp' ? node : quoteCommandPath(node) + target.suffix;
const hashCommand = (target: RegistrationNodeTarget, value: string) => sha(target.kind === 'mcp' ? JSON.stringify(value) : value);
const at = (value: any, path: (string | number)[]): any => path.reduce((value, key) => {
  assert.ok(value && typeof value === 'object' && Object.hasOwn(value, key), 'registration_target_missing'); return value[key];
}, value);
function replaceAt(value: any, path: (string | number)[], next: string): any {
  assert.ok(path.length > 0, 'registration_root_replacement_forbidden'); const [key, ...rest] = path;
  const copy = Array.isArray(value) ? value.slice() : { ...value };
  copy[key!] = rest.length ? replaceAt(value[key!], rest, next) : next; return copy;
}

/** Counts encoded source units only until the decoded prefix ends; the suffix bytes remain untouched. */
function jsonPrefixLength(raw: string, prefix: string) {
  let end = 0, decoded = '';
  while (decoded.length < prefix.length) {
    assert.ok(end < raw.length, 'registration_encoded_prefix_missing');
    if (raw[end] === '\\') {
      const size = raw[end + 1] === 'u' ? 6 : 2, escape = raw.slice(end, end + size);
      decoded += JSON.parse('"' + escape + '"'); end += size;
    } else decoded += raw[end++];
  }
  assert.equal(decoded, prefix, 'registration_encoded_prefix_changed'); return end;
}

/** Only TOML strings/comments need locations; smol-toml remains the syntax and value authority. */
function tomlStrings(text: string) {
  const tokens: { offset: number; end: number; quote: string; multiline: boolean; value: unknown }[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] === '#') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end + 1; continue; }
    const quote = text[index];
    if (quote !== '"' && quote !== "'") { index++; continue; }
    const offset = index, multiline = text.slice(index, index + 3) === quote.repeat(3), width = multiline ? 3 : 1;
    index += width; let closed = false;
    for (; index < text.length;) {
      if (quote === '"' && text[index] === '\\') { index += 2; continue; }
      if (text.slice(index, index + width) === quote.repeat(width)) {
        index += width;
        if (multiline) while (text[index] === quote) index++;
        closed = true; break;
      }
      index++;
    }
    assert.ok(closed, 'registration_toml_string_unclosed');
    const raw = text.slice(offset, index), value = parseToml('value = ' + raw).value;
    tokens.push({ offset, end: index, quote, multiline, value });
  }
  return tokens;
}

/** Pure codec only: target authorization and held native-file identity belong to the transaction caller. */
export function editRegistrationNodeBytes(bytes: Buffer, format: 'json' | 'toml', targets: RegistrationNodeTarget[], beforeNode: string, proposedNode: string) {
  assert.ok(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024 && targets.length > 0 && targets.length <= 4, 'registration_codec_bound');
  assert.ok(beforeNode !== proposedNode && [beforeNode, proposedNode].every(node => /^[\p{L}\p{N}_ .:/\\-]+$/u.test(node)), 'registration_node_token_invalid');
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(bom));
  const decode = (text: string) => format === 'json' ? strictJson(Buffer.from(text), 2 * 1024 * 1024) : parseToml(text, { maxDepth: 32 });
  const before = decode(text), tree = format === 'json' ? parseTree(text) : null, toml = format === 'toml' ? tomlStrings(text) : [];
  let expected = before; const edits: { offset: number; length: number; content: string }[] = [], paths = new Set<string>();
  for (const target of targets) {
    const key = JSON.stringify(target.path); assert.ok(!paths.has(key), 'registration_duplicate_target'); paths.add(key);
    const old = command(target, beforeNode), next = command(target, proposedNode), path = target.kind === 'mcp' ? [...target.path, 'command'] : target.path;
    assert.equal(hashCommand(target, old), target.beforeCommandSha256, 'registration_saved_before_hash_changed');
    assert.equal(hashCommand(target, next), target.proposedCommandSha256, 'registration_saved_proposed_hash_changed');
    assert.equal(at(before, path), old, 'registration_target_value_changed');
    if (target.kind === 'mcp') {
      const args = at(before, [...target.path, 'args']);
      assert.ok(Array.isArray(args) && args.length === 3 && args.every(value => typeof value === 'string'), 'registration_args_invalid');
      assert.equal(sha('[' + args.map(value => JSON.stringify(value)).join(', ') + ']'), target.argsSha256, 'registration_args_changed');
    }
    const prefix = target.kind === 'mcp' ? beforeNode : quoteCommandPath(beforeNode), replacement = target.kind === 'mcp' ? proposedNode : quoteCommandPath(proposedNode);
    if (format === 'json') {
      const node = tree && findNodeAtLocation(tree, path); assert.ok(node?.type === 'string' && node.value === old, 'registration_json_target_invalid');
      const raw = text.slice(node.offset + 1, node.offset + node.length - 1), length = jsonPrefixLength(raw, prefix);
      edits.push({ offset: node.offset + 1, length, content: JSON.stringify(replacement).slice(1, -1) });
    } else {
      assert.ok(target.kind === 'mcp' && targets.length === 1, 'registration_toml_scope_invalid');
      const matches = toml.filter(token => token.value === old); assert.equal(matches.length, 1, 'registration_toml_target_ambiguous');
      // shortcut: multiline command targets are refused; add exact source locations before migrating one.
      const token = matches[0]!; assert.ok(!token.multiline, 'registration_toml_multiline_target_unproved');
      const content = token.quote === '"' ? JSON.stringify(replacement).slice(1, -1) : replacement;
      assert.ok(token.quote !== "'" || !replacement.includes("'"), 'registration_toml_literal_unrepresentable');
      edits.push({ offset: token.offset + 1, length: token.end - token.offset - 2, content });
    }
    expected = replaceAt(expected, path, next);
  }
  edits.sort((a, b) => b.offset - a.offset);
  let afterText = text, previous = text.length;
  for (const edit of edits) {
    assert.ok(edit.offset >= 0 && edit.offset + edit.length <= previous, 'registration_edit_overlap');
    afterText = afterText.slice(0, edit.offset) + edit.content + afterText.slice(edit.offset + edit.length); previous = edit.offset;
  }
  const after = decode(afterText);
  assert.ok(format === 'json' ? isDeepStrictEqual(after, expected) : sameTomlValue(after, expected), 'registration_other_values_changed');
  const output = Buffer.concat([bytes.subarray(0, bom), Buffer.from(afterText)]);
  return { bytes: output, beforeSha256: sha(bytes), afterSha256: sha(output), tokenEdits: edits.length };
}
