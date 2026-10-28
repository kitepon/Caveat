import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { managedDeploymentPaths } from '@caveat/core';
import { resolveAgentConfigPaths, quoteCommandPath } from './installShared.js';
import { resolveHookNodePath } from './nodePath.js';
import type { RegistrationNodeTarget } from './registrationNodeCodec.js';

export type RegistrationObservationFile = { file: string; status: string; sha256: string; bytes: number; uid: number; gid: number; mode: string; dev: string; ino: string };
export type RegistrationFileSpec = { path: string; format: 'json' | 'toml'; observed: RegistrationObservationFile; targets: RegistrationNodeTarget[] };
export type RegistrationSources = { observation: Record<string, any>; proposal: Record<string, any> };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hooks: Record<string, Record<string, string>> = {
  claude: { PostToolUse: 'hook post-tool-use', Stop: 'hook stop', UserPromptSubmit: 'hook user-prompt-submit', PostToolUseFailure: 'hook post-tool-use' },
  codex: { UserPromptSubmit: 'codex-hook user-prompt-submit', Stop: 'codex-hook stop', PostToolUse: 'codex-hook post-tool-use' },
  cursor: { beforeSubmitPrompt: 'cursor-hook user-prompt-submit', stop: 'cursor-hook stop', postToolUse: 'cursor-hook post-tool-use', postToolUseFailure: 'cursor-hook post-tool-use' },
};

/** Saved paths are assertions against the seven derived product paths; they never define an execution scope. */
export function registrationFileSpecs(source: RegistrationSources, userHome: string) {
  const { observation: saved, proposal } = source;
  assert.ok(saved?.schema === 'caveat.main15_readonly_confirmation.v1' && proposal?.schema === 'caveat.main15_node_migration_proposal.v1', 'registration_projection_schema_invalid');
  assert.ok(typeof saved.expectedDedicatedNode === 'string' && isAbsolute(saved.expectedDedicatedNode)
    && typeof proposal.selectedNodeCandidate === 'string' && isAbsolute(proposal.selectedNodeCandidate)
    && saved.expectedDedicatedNode !== proposal.selectedNodeCandidate, 'registration_node_selection_invalid');
  assert.ok(Array.isArray(saved.files) && saved.files.length === 7 && Array.isArray(saved.definitions) && saved.definitions.length === 15
    && Array.isArray(proposal.originalConfigFiles) && proposal.originalConfigFiles.length === 7 && Array.isArray(proposal.changes) && proposal.changes.length === 15, 'registration_projection_scope_invalid');
  const configs = resolveAgentConfigPaths(userHome, {}), paths = managedDeploymentPaths(userHome), entry = quoteCommandPath(paths.launcher);
  const rows = [
    ['claude', 'mcp', configs.claudeMcp, 'json'], ['claude', 'hook', join(configs.claudeDir, 'settings.json'), 'json'],
    ['codex', 'mcp', join(configs.codexHome, 'config.toml'), 'toml'], ['codex', 'hook', join(configs.codexHome, 'hooks.json'), 'json'],
    ['grok', 'mcp', join(configs.grokHome, 'config.toml'), 'toml'], ['cursor', 'mcp', join(configs.cursorDir, 'mcp.json'), 'json'],
    ['cursor', 'hook', join(configs.cursorDir, 'hooks.json'), 'json'],
  ] as const;
  const files: RegistrationFileSpec[] = rows.map(([, , path, format]) => {
    const observed = saved.files.filter((file: any) => file.file === path), proposed = proposal.originalConfigFiles.filter((file: any) => file.file === path);
    assert.ok(observed.length === 1 && proposed.length === 1, 'registration_unapproved_file');
    assert.deepEqual(observed[0], proposed[0], 'registration_saved_file_changed');
    const row = observed[0] as RegistrationObservationFile;
    assert.ok(row.status === 'observed' && digest(row.sha256) && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 2 * 1024 * 1024
      && Number.isSafeInteger(row.uid) && Number.isSafeInteger(row.gid) && typeof row.mode === 'string' && /^0o[0-7]{3,4}$/.test(row.mode)
      && typeof row.dev === 'string' && /^\d+$/.test(row.dev) && typeof row.ino === 'string' && /^[1-9]\d*$/.test(row.ino), 'registration_saved_identity_invalid');
    return { path, format, observed: row, targets: [] };
  });
  const proposedNode = resolveHookNodePath();
  const ids = new Set<string>(), roles = new Set<string>();
  for (const def of saved.definitions) {
    assert.ok(def && typeof def.id === 'string' && !ids.has(def.id), 'registration_duplicate_definition'); ids.add(def.id);
    assert.ok(def.status === 'observed' && def.nodeSlotMatches === true && def.entryAndArgsMatch === true && digest(def.commandSha256), 'registration_unconfirmed_definition');
    const changes: Record<string, any>[] = proposal.changes.filter((row: any) => row.id === def.id); assert.equal(changes.length, 1, 'registration_proposal_definition_missing');
    const change = changes[0]!;
    assert.ok(change.kind === def.kind && change.client === def.client && change.source_file === def.source_file && change.json_pointer === def.json_pointer
      && change.beforeCommandSha256 === def.commandSha256 && change.beforeNode === saved.expectedDedicatedNode && change.proposedNode === proposal.selectedNodeCandidate
      && digest(change.proposedCommandSha256), 'registration_proposal_definition_changed');
    const fileIndex = rows.findIndex(([client, kind, path]) => client === def.client && kind === def.kind && path === def.source_file);
    assert.ok(fileIndex >= 0, 'registration_unapproved_file');
    let target: RegistrationNodeTarget, role: string;
    if (def.kind === 'mcp') {
      const key = def.client === 'codex' || def.client === 'grok' ? 'mcp_servers' : 'mcpServers';
      assert.equal(def.json_pointer, '/' + key + '/caveat', 'registration_mcp_pointer_invalid');
      assert.equal(def.id, def.client + ':mcp:caveat', 'registration_definition_id_invalid');
      const args = ['--disable-warning=ExperimentalWarning', paths.launcher, 'mcp-server'];
      const argsSha256 = sha('[' + args.map(value => JSON.stringify(value)).join(', ') + ']');
      assert.equal(def.argsSha256, argsSha256, 'registration_saved_args_unbound');
      assert.equal(change.expectedSuffix, null, 'registration_mcp_suffix_invalid'); role = def.client + '/mcp';
      target = { path: [key, 'caveat'], kind: 'mcp', suffix: '', argsSha256, beforeCommandSha256: change.beforeCommandSha256, proposedCommandSha256: sha(def.kind === 'mcp' ? JSON.stringify(proposedNode) : quoteCommandPath(proposedNode) + change.expectedSuffix) };
    } else {
      assert.ok(def.kind === 'hook' && typeof def.json_pointer === 'string' && def.exactRecordedAfterNodeOnlyChange === true, 'registration_hook_unconfirmed');
      const pattern = def.client === 'cursor' ? /^\/hooks\/([a-zA-Z]+)\/(0|[1-9][0-9]*)\/command$/ : /^\/hooks\/([a-zA-Z]+)\/(0|[1-9][0-9]*)\/hooks\/(0|[1-9][0-9]*)\/command$/;
      const match = pattern.exec(def.json_pointer), handler = match && Object.hasOwn(hooks[def.client] ?? {}, match[1]!) ? hooks[def.client]![match![1]!] : undefined;
      assert.ok(match && handler && match.slice(2).every(part => Number(part) <= 63), 'registration_hook_pointer_invalid');
      assert.equal(def.id, def.client + ':hook:' + def.json_pointer, 'registration_definition_id_invalid');
      const suffix = ' ' + entry + ' ' + handler; assert.equal(change.expectedSuffix, suffix, 'registration_hook_suffix_changed');
      role = def.client + '/' + match[1];
      target = { path: def.json_pointer.slice(1).split('/').map((part: string) => /^\d+$/.test(part) ? Number(part) : part),
        kind: 'hook', suffix, beforeCommandSha256: change.beforeCommandSha256, proposedCommandSha256: sha(def.kind === 'mcp' ? JSON.stringify(proposedNode) : quoteCommandPath(proposedNode) + change.expectedSuffix) };
    }
    assert.ok(!roles.has(role), 'registration_duplicate_role'); roles.add(role); files[fileIndex]!.targets.push(target);
  }
  assert.equal(roles.size, 15, 'registration_missing_definition');
  assert.ok(files.every(file => file.targets.length >= 1 && file.targets.length <= 4), 'registration_missing_file_targets');
  const clientsToClose = [...new Set(rows.map(([client]) => client))].map(client => ({ client, files: rows.filter(([owner]) => owner === client).map(([, , path]) => path) }));
  return { files, clientsToClose, beforeNode: saved.expectedDedicatedNode as string, proposedNode };
}
