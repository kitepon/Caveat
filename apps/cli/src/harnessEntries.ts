import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { claudeHookCommand, claudeHookEntry } from './claudeInstall.js';
import { codexHookCommand, codexHookEntry } from './codexHookInstall.js';
import { cursorHookCommand, cursorHookEntry } from './cursorInstall.js';
import { resolveRegistrationCliPath } from './installShared.js';
import { createMcpRegistration, type McpClient } from './mcpInstall.js';
import { resolveHookNodePath } from './nodePath.js';
import { CAVEAT_VERSION } from './version.js';

const clients: readonly McpClient[] = ['claude', 'codex', 'grok', 'cursor'];
type HookEvent = 'user-prompt-submit' | 'post-tool-use' | 'stop';

/** Only the public managed-entry resolver reads state; no CLI config or CliContext. */
export function harnessEntries(
  cliScriptPath: string,
  userHome = homedir(),
  harnesses: readonly string[] = clients,
  platform: NodeJS.Platform = process.platform,
) {
  if (!cliScriptPath) throw new Error('harness_entries_cli_path_missing');
  for (const name of harnesses) {
    if (!clients.includes(name as McpClient)) throw new Error(`unsupported harness: ${name}`);
  }
  const selected = [...new Set(harnesses)] as McpClient[];
  const entry = resolveRegistrationCliPath(resolve(cliScriptPath), resolve(userHome));
  const node = resolveHookNodePath();
  const claude = (event: HookEvent) => [{ hooks: [claudeHookEntry(claudeHookCommand(node, entry, event))] }];
  const codex = (event: HookEvent) => [{ hooks: [codexHookEntry(codexHookCommand(node, entry, event, platform))] }];
  const cursor = (event: HookEvent) => [cursorHookEntry(cursorHookCommand(node, entry, event))];
  const definitions = {
    claude: {
      UserPromptSubmit: claude('user-prompt-submit'),
      PostToolUse: claude('post-tool-use'),
      PostToolUseFailure: claude('post-tool-use'),
      Stop: claude('stop'),
    },
    codex: {
      UserPromptSubmit: codex('user-prompt-submit'),
      PostToolUse: codex('post-tool-use'),
      Stop: codex('stop'),
    },
    cursor: {
      beforeSubmitPrompt: cursor('user-prompt-submit'),
      postToolUse: cursor('post-tool-use'),
      postToolUseFailure: cursor('post-tool-use'),
      stop: cursor('stop'),
    },
  };
  return {
    schema: 'bellteam.harness-entries.v1',
    product: 'caveat',
    version: CAVEAT_VERSION,
    mcpServers: {
      caveat: Object.fromEntries(selected.map(client => [client, createMcpRegistration(client, node, entry)])),
    },
    hooks: Object.fromEntries(selected.filter(client => client !== 'grok').map(client => [client, definitions[client]])),
    settings: selected.includes('codex') ? { codex: { 'features.hooks': true } } : {},
    owns: { commandIncludes: ['caveat.js', 'caveat.mjs'] },
  };
}
