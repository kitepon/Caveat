import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { stageManagedDeployment, activateManagedDeployment, managedDeploymentPaths, isWindows } from '@caveat/core';
import { runWindowsAclPrivateTree } from '../../../packages/core/src/privateWindowsAcl.js';
import { quoteCommandPath } from '../src/installShared.js';
import type { RegistrationInput } from '../src/registrationMigration.js';
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export function registrationFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-registration-'))), home = join(root, 'profile'); mkdirSync(home, { mode: 0o700 });
  const source = join(root, 'source'); mkdirSync(join(source, 'dist'), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'caveat-cli', version: '1.0.0', bin: { caveat: 'dist/caveat.js' } }), { mode: 0o600 });
  for (const name of ['caveat.js', 'stable-entry.mjs', 'managed-deployment.js']) writeFileSync(join(source, 'dist', name), '// isolated ' + name + '\n', { mode: 0o600 });
  if (isWindows()) runWindowsAclPrivateTree(root);
  const staged = stageManagedDeployment(source, { userHome: home }); activateManagedDeployment(staged.release, { userHome: home });
  const paths = managedDeploymentPaths(home), old = join(home, 'dedicated', 'bin', isWindows() ? 'node.exe' : 'node'), node = process.execPath;
  const definitions: any[] = [], changes: any[] = [], documents = new Map<string, any>();
  function add(client: string, kind: string, file: string, pointer: string, suffix: string | null) {
    const path = kind === 'mcp' ? pointer.slice(1).split('/') : pointer.slice(1).split('/').map(part => /^\d+$/.test(part) ? Number(part) : part);
    let value = documents.get(file); if (!value) { value = { other: { environment: 'untouched', secret: 'fixture-private', args: [1, 2] } }; documents.set(file, value); }
    let at = value;
    for (let index = 0; index < path.length - 1; index++) { const key = path[index]!; at[key] ??= typeof path[index + 1] === 'number' ? [] : {}; at = at[key]; }
    const args = ['--disable-warning=ExperimentalWarning', paths.launcher, 'mcp-server'];
    at[path.at(-1)!] = kind === 'mcp' ? { command: old, args, env: { KEEP: 'private' } } : quoteCommandPath(old) + suffix!;
    const id = kind === 'mcp' ? client + ':mcp:caveat' : client + ':hook:' + pointer;
    const before = kind === 'mcp' ? JSON.stringify(old) : quoteCommandPath(old) + suffix!, after = kind === 'mcp' ? JSON.stringify(node) : quoteCommandPath(node) + suffix!;
    definitions.push({ id, kind, client, source_file: file, json_pointer: pointer, status: 'observed', nodeSlotMatches: true, entryAndArgsMatch: true,
      ...(kind === 'mcp' ? { argsSha256: sha('[' + args.map(value => JSON.stringify(value)).join(', ') + ']') } : { exactRecordedAfterNodeOnlyChange: true }), commandSha256: sha(before) });
    changes.push({ id, kind, client, source_file: file, json_pointer: pointer, expectedSuffix: suffix, beforeNode: old, proposedNode: node, beforeCommandSha256: sha(before), proposedCommandSha256: sha(after) });
  }
  for (const [client, file, key] of [['claude', '.claude.json', 'mcpServers'], ['codex', '.codex/config.toml', 'mcp_servers'], ['grok', '.grok/config.toml', 'mcp_servers'], ['cursor', '.cursor/mcp.json', 'mcpServers']]) add(client!, 'mcp', join(home, file!), '/' + key + '/caveat', null);
  const commands: Record<string, Record<string, string>> = {
    claude: { PostToolUse: 'hook post-tool-use', Stop: 'hook stop', UserPromptSubmit: 'hook user-prompt-submit', PostToolUseFailure: 'hook post-tool-use' },
    codex: { UserPromptSubmit: 'codex-hook user-prompt-submit', Stop: 'codex-hook stop', PostToolUse: 'codex-hook post-tool-use' },
    cursor: { beforeSubmitPrompt: 'cursor-hook user-prompt-submit', stop: 'cursor-hook stop', postToolUse: 'cursor-hook post-tool-use', postToolUseFailure: 'cursor-hook post-tool-use' },
  };
  for (const [client, events] of Object.entries(commands)) for (const [event, command] of Object.entries(events)) {
    const file = join(home, '.' + client, client === 'claude' ? 'settings.json' : 'hooks.json');
    add(client, 'hook', file, '/hooks/' + event + (client === 'cursor' ? '/0/command' : '/0/hooks/0/command'), ' ' + quoteCommandPath(paths.launcher) + ' ' + command);
  }
  for (const [file, value] of documents) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const text = file.endsWith('.toml') ? 'other = "unchanged"\n[mcp_servers.caveat]\ncommand = ' + JSON.stringify(old) + '\nargs = ' + JSON.stringify(value.mcp_servers.caveat.args) + '\n[mcp_servers.caveat.env]\nKEEP = "private"\n'
      : JSON.stringify(value, null, 2) + '\n';
    writeFileSync(file, text, { mode: 0o600 });
  }
  if (isWindows()) runWindowsAclPrivateTree(root);
  const files = [...documents.keys()].map(file => { const bytes = readFileSync(file), stat = statSync(file, { bigint: true }); return { file, status: 'observed', sha256: sha(bytes), bytes: bytes.length,
    uid: Number(stat.uid), gid: Number(stat.gid), mode: '0o' + (stat.mode & 0o777n).toString(8), dev: String(stat.dev), ino: String(stat.ino) }; });
  const input: RegistrationInput = { userHome: home, nodeVersion: process.version, source: {
    observation: { schema: 'caveat.main15_readonly_confirmation.v1', expectedDedicatedNode: old, files, definitions },
    proposal: { schema: 'caveat.main15_node_migration_proposal.v1', selectedNodeCandidate: node, originalConfigFiles: structuredClone(files), changes },
  } };
  const original = new Map(files.map(file => [file.file, readFileSync(file.file)]));
  return { root, home, paths, input, original };
}
