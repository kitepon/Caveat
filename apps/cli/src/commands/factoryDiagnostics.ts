import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseToml } from 'smol-toml';
import { isCanonicalCaveatCodexHookEntry } from '../codexHookInstall.js';
import { isCanonicalCaveatClaudeHookCommand, isCaveatClaudeMcpRegistration } from '../claudeInstall.js';
import { diagnoseCursorHookConnector } from '../cursorInstall.js';
import type { CliContext } from '../context.js';
import { CAVEAT_VERSION } from '../version.js';
import { resolveAgentConfigPaths } from '../installShared.js';

type Status = 'ready' | 'not_ready' | 'unverified';
export type FactoryConnector = 'cursor';
const status = (ok: boolean, reason: string): { status: Status; reason_code: string } => ({ status: ok ? 'ready' : 'not_ready', reason_code: ok ? 'ready' : reason });
const unverified = (reason: string): { status: Status; reason_code: string } => ({ status: 'unverified', reason_code: reason });
function hook(present: boolean) { return status(present, 'not_installed'); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function claudeRegistration(path: string, nodePath: string, cliScriptPath: string) {
  if (!existsSync(path)) return status(false, 'not_registered');
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(value) || !isRecord(value.mcpServers)) return status(false, 'not_registered');
    return status(isCaveatClaudeMcpRegistration(value.mcpServers.caveat, nodePath, cliScriptPath), 'not_registered');
  } catch { return unverified('config_unreadable'); }
}
function claudeHooks(claudeDir: string, nodePath: string, cliScriptPath: string) {
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    const present = (event: string, subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop') => settings.hooks?.[event]?.some((entry) => entry.hooks?.some((item) => typeof item.command === 'string' && isCanonicalCaveatClaudeHookCommand(item.command, subcommand, nodePath, cliScriptPath))) ?? false;
    return { user_prompt_submit: hook(present('UserPromptSubmit', 'user-prompt-submit')), post_tool_use: hook(present('PostToolUse', 'post-tool-use')), post_tool_use_failure: hook(present('PostToolUseFailure', 'post-tool-use')), stop: hook(present('Stop', 'stop')) };
  } catch { const bad = unverified('config_unreadable'); return { user_prompt_submit: { ...bad }, post_tool_use: { ...bad }, post_tool_use_failure: { ...bad }, stop: { ...bad } }; }
}
const EXPECTED_SEARCH_SQL = new Map([
  ['entries_fts', "create virtual table entries_fts using fts5( id unindexed, title, body, tags, content='entries', content_rowid='rowid', tokenize='trigram' )"],
  ['entries_ai', 'create trigger entries_ai after insert on entries begin insert into entries_fts(rowid, id, title, body, tags) values (new.rowid, new.id, new.title, new.body, new.tags); end'],
  ['entries_ad', "create trigger entries_ad after delete on entries begin insert into entries_fts(entries_fts, rowid, id, title, body, tags) values('delete', old.rowid, old.id, old.title, old.body, old.tags); end"],
  ['entries_au', "create trigger entries_au after update on entries begin insert into entries_fts(entries_fts, rowid, id, title, body, tags) values('delete', old.rowid, old.id, old.title, old.body, old.tags); insert into entries_fts(rowid, id, title, body, tags) values (new.rowid, new.id, new.title, new.body, new.tags); end"],
]);
function strictSearchSchema(db: DatabaseSync): boolean {
  const normalize = (sql: string | null) => (sql ?? '').toLowerCase().replace(/\s+/g, ' ');
  const objects = db.prepare("SELECT name, sql FROM sqlite_master WHERE name = 'entries_fts' OR (type = 'trigger' AND tbl_name = 'entries')").all() as Array<{ name: string; sql: string | null }>;
  if (objects.length !== EXPECTED_SEARCH_SQL.size || objects.some((object) => normalize(object.sql) !== EXPECTED_SEARCH_SQL.get(object.name))) return false;
  const columns = db.prepare('PRAGMA table_xinfo(entries_fts)').all() as Array<{ name: string; hidden: number }>;
  return columns.map((column) => `${column.name}:${column.hidden}`).join(',') === 'id:0,title:0,body:0,tags:0,entries_fts:1,rank:1';
}
function database(path: string) {
  if (!existsSync(path)) return { status: 'not_ready' as Status, reason_code: 'missing', schema_version: null, supported_schema_version: 3, migration_status: 'unverified' as const };
  try { const db = new DatabaseSync(path, { readOnly: true }); try { const row = db.prepare('PRAGMA user_version').get() as { user_version: number }; const columns = (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map((entry) => entry.name); const expectedColumns = ['rowid','id','source','path','title','body','frontmatter_json','tags','confidence','visibility','file_mtime','indexed_at','last_hit_at','topical_text','symptom_text']; const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = 'entries_fts' OR (type = 'trigger' AND tbl_name = 'entries')").all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>; const normalized = (sql: string | null) => (sql ?? '').toLowerCase().replace(/\s+/g, ' '); const ftsSql = normalized(objects.find((entry) => entry.type === 'table' && entry.name === 'entries_fts')?.sql ?? null); const fts = ftsSql.startsWith('create virtual table entries_fts using fts5(') && ftsSql.includes("content='entries'") && ftsSql.includes("content_rowid='rowid'") && ftsSql.includes("tokenize='trigram'"); const triggers = new Map(objects.filter((entry) => entry.type === 'trigger').map((entry) => [entry.name, normalized(entry.sql)])); const triggerShape = triggers.size === 3 && triggers.get('entries_ai')?.includes('after insert on entries') && triggers.get('entries_ai')?.includes('insert into entries_fts') && triggers.get('entries_ad')?.includes('after delete on entries') && triggers.get('entries_ad')?.includes("values('delete'") && triggers.get('entries_au')?.includes('after update on entries') && triggers.get('entries_au')?.includes("values('delete'") && (triggers.get('entries_au')?.match(/insert into entries_fts/g)?.length ?? 0) === 2; const indexes = db.prepare('PRAGMA index_list(entries)').all() as Array<{ name: string; unique: number }>; const uniqueSourceId = indexes.some((index) => index.unique === 1 && (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>).map((part) => part.name).join(',') === 'source,id'); const current = row.user_version === 3 && columns.join(',') === expectedColumns.join(',') && fts && Boolean(triggerShape) && uniqueSourceId && strictSearchSchema(db); return { status: current ? 'ready' as Status : 'not_ready' as Status, reason_code: current ? 'ready' : 'schema_contract_mismatch', schema_version: row.user_version, supported_schema_version: 3, migration_status: current ? 'current' as const : 'failed' as const }; } finally { db.close(); } } catch { return { status: 'unverified' as Status, reason_code: 'open_failed', schema_version: null, supported_schema_version: 3, migration_status: 'unverified' as const }; }
}
function codexFeature(codexHome: string) {
  const path = join(codexHome, 'config.toml'); if (!existsSync(path)) return status(false, 'feature_disabled');
  try { const config = parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>; if (!isRecord(config.features)) return status(false, 'feature_disabled'); const features = config.features as Record<string, unknown>; return status(features.hooks === true && features.codex_hooks === undefined, 'feature_disabled'); } catch { return unverified('config_unreadable'); }
}
function codexHooks(codexHome: string, nodePath: string, cliScriptPath: string) {
  const value: unknown = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')); if (!isRecord(value) || !isRecord(value.hooks)) throw Error('config_unreadable');
  const hooks = value.hooks as Record<string, unknown>; const present = (event: string, subcommand: 'user-prompt-submit' | 'post-tool-use' | 'stop') => Array.isArray(hooks[event]) && hooks[event].some((entry) => isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some((item) => isCanonicalCaveatCodexHookEntry(item, subcommand, nodePath, cliScriptPath)));
  return { userPromptSubmit: present('UserPromptSubmit', 'user-prompt-submit'), postToolUse: present('PostToolUse', 'post-tool-use'), stop: present('Stop', 'stop') };
}
function sync(own: string) {
  try { execFileSync('git', ['-C', own, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); } catch { return status(false, 'not_git_worktree'); }
  try {
    execFileSync('git', ['-C', own, 'remote', 'get-url', 'origin'], { stdio: 'ignore' });
  } catch { return status(false, 'origin_missing'); }
  try {
    const dirty = execFileSync('git', ['-C', own, 'status', '--porcelain=v1', '--untracked-files=normal'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
    if (dirty) return status(false, 'worktree_dirty');
    const upstream = execFileSync('git', ['-C', own, 'rev-parse', '--symbolic-full-name', '@{upstream}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    if (!upstream.startsWith('refs/remotes/origin/')) return status(false, 'upstream_not_origin');
    const remoteRef = `refs/heads/${upstream.slice('refs/remotes/origin/'.length)}`;
    const remote = execFileSync('git', ['-C', own, 'ls-remote', '--exit-code', 'origin', remoteRef], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 16_384 }).trim().split(/\s+/)[0];
    const head = execFileSync('git', ['-C', own, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
    if (!/^[0-9a-f]{40}$/.test(remote ?? '') || !/^[0-9a-f]{40}$/.test(head)) return unverified('sync_hash_unparseable');
    if (remote !== head) return status(false, 'remote_mismatch');
    const counts = execFileSync('git', ['-C', own, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim().split(/\s+/).map(Number);
    if (counts.length !== 2 || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) return unverified('sync_count_unparseable');
    if (counts[0] === 0 && counts[1] === 0) return status(true, 'ready');
    return status(false, counts[0] && counts[1] ? 'diverged' : counts[0] ? 'behind' : 'ahead');
  } catch { return unverified('upstream_unavailable'); }
}
export function factoryDiagnostics(
  ctx: CliContext,
  codexHome = resolveAgentConfigPaths(ctx.userHome).codexHome,
  requiredConnectors: readonly FactoryConnector[] = [],
) {
  const { claudeDir, claudeMcp, cursorDir } = resolveAgentConfigPaths(ctx.userHome);
  const nodePath = process.execPath; const cliScriptPath = process.argv[1] ?? '';
  const db = database(ctx.paths.dbPath); const feature = codexFeature(codexHome); let installedCodexHooks: { userPromptSubmit: boolean; postToolUse: boolean; stop: boolean } | null = null; try { installedCodexHooks = codexHooks(codexHome, nodePath, cliScriptPath); } catch {}
  const codexHook = (present: boolean | undefined) => present === undefined ? unverified('config_unreadable') : !present ? hook(false) : feature.status === 'ready' ? hook(true) : { ...feature };
  const output = { schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: CAVEAT_VERSION, overall: { status: 'unverified' as Status }, database: db, sync: sync(ctx.paths.knowledgeRepo), connectors: { claude: { status: 'unverified' as Status, mcp: claudeRegistration(claudeMcp, nodePath, cliScriptPath), hooks: claudeHooks(claudeDir, nodePath, cliScriptPath) }, codex: { status: 'unverified' as Status, hooks: { user_prompt_submit: codexHook(installedCodexHooks?.userPromptSubmit), post_tool_use: codexHook(installedCodexHooks?.postToolUse), stop: codexHook(installedCodexHooks?.stop) } }, cursor: diagnoseCursorHookConnector(cursorDir, nodePath, cliScriptPath) } };
  const aggregate = (all: Status[]): Status => all.includes('not_ready') ? 'not_ready' : all.includes('unverified') ? 'unverified' : 'ready';
  const connectorStatus = (connector: { mcp?: { status: Status }; hooks: Record<string, { status: Status }> }): Status => aggregate([...Object.values(connector.hooks), ...(connector.mcp ? [connector.mcp] : [])].map((v) => v.status));
  output.connectors.claude.status = connectorStatus(output.connectors.claude); output.connectors.codex.status = connectorStatus(output.connectors.codex);
  const statuses = [output.database.status, output.sync.status, output.connectors.claude.status, output.connectors.codex.status];
  if (requiredConnectors.includes('cursor')) statuses.push(output.connectors.cursor.compatibility_status);
  output.overall.status = aggregate(statuses);
  return output;
}
