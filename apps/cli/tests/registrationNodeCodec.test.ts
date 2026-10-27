import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { editRegistrationNodeBytes, type RegistrationNodeTarget } from '../src/registrationNodeCodec.js';
const old = '/old/node', next = '/normal/node', suffix = ' /fixed/entry.mjs hook post-tool-use';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
function target(path: (string | number)[], kind: 'hook' | 'mcp' = 'hook', args?: string[]): RegistrationNodeTarget {
  return { path, kind, suffix: kind === 'hook' ? suffix : '', beforeCommandSha256: sha(kind === 'mcp' ? JSON.stringify(old) : old + suffix),
    proposedCommandSha256: sha(kind === 'mcp' ? JSON.stringify(next) : next + suffix), ...(args ? { argsSha256: sha('[' + args.map(v => JSON.stringify(v)).join(', ') + ']') } : {}) };
}
describe('exact registration Node byte codec', () => {
  it('edits two approved identical commands while preserving identical off-target data', () => {
    const value = old + suffix, text = JSON.stringify({ hooks: [value, value], other: value });
    const result = editRegistrationNodeBytes(Buffer.from(text), 'json', [target(['hooks', 0]), target(['hooks', 1])], old, next);
    expect(result.bytes.toString()).toBe(JSON.stringify({ hooks: [next + suffix, next + suffix], other: value })); expect(result.tokenEdits).toBe(2);
  });
  it('preserves BOM, CRLF, whitespace, escaped suffix and unrelated Unicode bytes', () => {
    const text = '\uFEFF{\r\n  "value" : "\\/old\\/no\\u0064e \\/fixed\\/entry.mjs hook post-tool-use", "other":"日本語🍊"\r\n}\r\n';
    const result = editRegistrationNodeBytes(Buffer.from(text), 'json', [target(['value'])], old, next);
    expect(result.bytes.toString()).toBe(text.replace('\\/old\\/no\\u0064e', next));
  });
  it('preserves MCP args, including commas inside strings, and unrelated __proto__ properties', () => {
    const args = ['--disable-warning=ExperimentalWarning', '/fixed,a/entry.mjs', 'mcp-server'];
    const text = '{"mcp":{"command":"/old/node","args":' + JSON.stringify(args) + '},"__proto__":{"kept":true}}';
    expect(editRegistrationNodeBytes(Buffer.from(text), 'json', [target(['mcp'], 'mcp', args)], old, next).bytes.toString()).toBe(text.replace(old, next));
    expect(({} as any).kept).toBeUndefined();
  });
  it('refuses duplicate JSON properties, missing pointers, changed values and overlapping targets', () => {
    expect(() => editRegistrationNodeBytes(Buffer.from('{"v":"' + old + suffix + '","v":"' + old + suffix + '"}'), 'json', [target(['v'])], old, next)).toThrow('json_invalid');
    expect(() => editRegistrationNodeBytes(Buffer.from('{}'), 'json', [target(['v'])], old, next)).toThrow('target_missing');
    expect(() => editRegistrationNodeBytes(Buffer.from('{"v":"foreign"}'), 'json', [target(['v'])], old, next)).toThrow('value_changed');
    expect(() => editRegistrationNodeBytes(Buffer.from(JSON.stringify({ v: old + suffix })), 'json', [target(['v']), target(['v'])], old, next)).toThrow('duplicate_target');
  });
  it.each(['json', 'toml'] as const)('refuses invalid UTF8 and an unsafe Node token for %s', format => {
    expect(() => editRegistrationNodeBytes(Buffer.from([0xff]), format, [target(['v'])], old, next)).toThrow();
    expect(() => editRegistrationNodeBytes(Buffer.from('{}'), format, [target(['v'])], old, '/node;evil')).toThrow('node_token_invalid');
  });
  it.each(['"', "'"])('preserves TOML %s quoting, comments, multiline text and nanosecond dates', quote => {
    const args = ['--disable-warning=ExperimentalWarning', '/fixed/entry.mjs', 'mcp-server'];
    const text = '# "' + old + '" in a comment\r\ntext = """A multiline\nstring with \'single\' quotes"""\nwhen = 2026-10-27T12:00:00.123456789Z\n[mcp]\ncommand = ' + quote + old + quote + '\nargs = ' + JSON.stringify(args) + '\n';
    const result = editRegistrationNodeBytes(Buffer.from(text), 'toml', [target(['mcp'], 'mcp', args)], old, next);
    expect(result.bytes.toString()).toBe(text.replace('command = ' + quote + old + quote, 'command = ' + quote + next + quote));
  });
  it('refuses ambiguous or multiline TOML target strings and preserves changed args', () => {
    const args = ['--disable-warning=ExperimentalWarning', '/fixed/entry.mjs', 'mcp-server'], t = target(['mcp'], 'mcp', args);
    const tail = '\n[mcp]\ncommand = "' + old + '"\nargs = ' + JSON.stringify(args);
    expect(() => editRegistrationNodeBytes(Buffer.from('other = "' + old + '"' + tail), 'toml', [t], old, next)).toThrow('target_ambiguous');
    expect(() => editRegistrationNodeBytes(Buffer.from(tail.replace('"' + old + '"', "'''" + old + "'''")), 'toml', [t], old, next)).toThrow('multiline_target_unproved');
    expect(() => editRegistrationNodeBytes(Buffer.from(tail.replace('mcp-server', 'foreign')), 'toml', [t], old, next)).toThrow('args_changed');
  });
});
