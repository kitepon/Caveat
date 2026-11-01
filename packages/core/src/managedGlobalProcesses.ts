import assert from 'node:assert/strict';
import { isClaudeCodeProcess } from './managedClaudeProcess.js';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nativeGlobalProcessTables } from './managedProcessNative.js';
import type { NativeProcessRecord, NativeProcessTables, ProcessProbeEvent } from './managedProcessNative.js';

export type GlobalProcessScope = { packageRoot?: string; npmRoot?: string; binAliases: string[]; protectedPaths?: string[]; observeConfigWriters?: boolean };
export type GlobalProcessAssessment = { pid: number; birth: string | null; parentPid: number | null; parentApp: string;
  protectedPaths?: string[];
  configIdentity?: { dev: string; ino: string };
  classification: 'consumer' | 'writer' | 'observation'; reason: string; resolution: { action: 'close-process' | 'finish-npm-operation' | 'observe'; instruction: string } };
const normalized = (value: string, fold: boolean) => {
  const slash = value.replaceAll('\\', '/').replace(/\/$/, ''); return fold ? slash.toLowerCase() : slash;
};
const absolute = (value: string) => value.startsWith('/') || /^[a-z]:[\\/]/i.test(value);
function validateScope(scope: GlobalProcessScope) {
  const paths = [scope.packageRoot, scope.npmRoot, ...scope.binAliases, ...(scope.protectedPaths ?? [])].filter((value): value is string => value !== undefined);
  assert.ok(paths.length > 0 && paths.length <= 256, 'process_scope_required');
  assert.ok(paths.map(value => normalized(value, false)).every(value => absolute(value) && value.length > 1 && !/[\x00-\x1f]/.test(value) && !value.split('/').some(part => part === '.' || part === '..')), 'absolute_process_scope_required');
}
function hasLiteral(value: string, path: string) {
  let offset = value.indexOf(path);
  while (offset >= 0) {
    const next = value[offset + path.length];
    if (next === undefined || !/[\p{L}\p{N}_.-]/u.test(next)) return true;
    offset = value.indexOf(path, offset + 1);
  }
  return false;
}
export function processAppName(row: NativeProcessRecord | undefined) {
  if (!row) return 'unavailable';
  const text = [row.executable?.path, ...(row.argv?.slice(0, 2) ?? [])].filter(Boolean).join(' ').replaceAll('\\', '/');
  if (isClaudeCodeProcess(row.argv, row.executable?.path)) return 'Claude Code';
  if (/(?:^|\/)codex(?:\.exe)?(?: |$)/i.test(text)) return 'Codex';
  if (/(?:^|\/)cursor(?:\.exe)?(?: |$)/i.test(text)) return 'Cursor';
  if (/(?:^|\/)grok(?:\.exe)?(?: |$)/i.test(text)) return 'Grok';
  return (row.executable?.path ?? row.argv?.[0])?.replaceAll('\\', '/').split('/').at(-1) ?? 'unavailable';
}
export const globalProcessResidualRisks = [
  'a later dynamic import of the old global can fail with module not found after quarantine',
  'views whose file handles are closed and previously read JavaScript caches are not observed',
  'root or administrator writes are not excluded',
  'writers with unreadable handles and writers that open or replace files between observations are not identified',
  'Windows open-handle writer attribution is unavailable; retained protected handles still exclude writes and deletion',
] as const;

/** Only readable references to the old package and readable config writers stop migration. */
export function assessGlobalProcesses(scope: GlobalProcessScope, tables: NativeProcessTables) {
  validateScope(scope);
  const norm = (value: string) => normalized(value, tables.caseInsensitive);
  const root = scope.packageRoot ? norm(scope.packageRoot) : null;
  const aliases = scope.binAliases.map(norm), rows = new Map<number, NativeProcessRecord[]>();
  const before = new Set(tables.before.map(row => row.pid)), after = new Set(tables.after.map(row => row.pid));
  for (const row of [...tables.before, ...tables.after]) rows.set(row.pid, [...(rows.get(row.pid) ?? []), row]);
  const records: GlobalProcessAssessment[] = [];
  const counts = { observed: rows.size, unreadable: 0, foreign: 0, kernel: 0, shortLived: 0, consumer: 0, writer: 0, observation: 0 };
  const own = rows.get(tables.selfPid)?.at(-1);
  const protectedFiles = (scope.protectedPaths ?? []).flatMap(path => {
    const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stat?.isFile() ? [{ path, dev: String(stat.dev), ino: String(stat.ino) }] : [];
  });
  const protectedConfigs = protectedFiles.filter(file => /(?:^|[\\/])\.claude\.json$/.test(file.path));
  const configWriter = protectedConfigs.length > 0;
  for (const [pid, observed] of rows) {
    const row = observed.at(-1)!;
    if (pid === tables.selfPid) continue;
    if (observed.some(value => !value.argv || !value.executable)) counts.unreadable++;
    if (own?.uid !== null && own?.uid !== undefined && observed.some(value => value.uid !== null && value.uid !== own.uid)) counts.foreign++;
    if (observed.some(value => value.kernel || value.state === 'Z')) { counts.kernel++; continue; }
    if (!before.has(pid) || !after.has(pid)) counts.shortLived++;
    if (!after.has(pid)) continue;
    const current = [row];
    const consumer = root && current.some(value => (value.executable && hasLiteral(norm(value.executable.path).replace(/ \(deleted\)$/, ''), root))
      || value.argv?.some(arg => hasLiteral(norm(arg), root) || aliases.some(alias => norm(arg) === alias)));
    const claude = configWriter && row.argv && processAppName(row) === 'Claude Code';
    const configKnown = own?.uid != null && row.uid === own.uid && row.claudeConfig != null && !row.reason;
    if (claude && !configKnown && !observed.some(value => !value.argv || !value.executable)) counts.unreadable++;
    const claudeWriter = claude && configKnown && protectedConfigs.some(identity => identity.dev === row.claudeConfig!.dev && identity.ino === row.claudeConfig!.ino);
    const stableBirth = row.birth !== null && observed.every(value => value.birth === row.birth && value.uid === row.uid);
    const openFiles = own?.uid != null && row.uid === own.uid && stableBirth && !row.reason
      ? protectedFiles.filter(file => row.openWriters?.some(value => value.dev === file.dev && value.ino === file.ino)) : [];
    if (row.openWritersUnverified || row.openWriters === null || row.openWriters?.length && (!stableBirth || row.reason)) counts.unreadable++;
    const writer = root && scope.npmRoot && current.some(value => {
      const argv = value.argv?.map(norm); if (!argv) return false;
      return argv.some(arg => hasLiteral(arg, norm(scope.npmRoot!)))
        && argv.some(arg => /^(?:install|i|uninstall|un|remove|rm|update|up|rebuild|link)$/.test(arg))
        && (argv.some(arg => hasLiteral(arg, root)) || argv.some(arg => ['-g', '--global'].includes(arg)) && argv.some(arg => /^caveat-cli(?:@|$)/.test(arg)));
    });
    if (!consumer && !claudeWriter && !writer && !openFiles.length) continue;
    const classification = writer || openFiles.length || claudeWriter && !scope.observeConfigWriters ? 'writer' : consumer ? 'consumer' : 'observation'; counts[classification]++;
    const parentApp = processAppName(rows.get(row.ppid ?? -1)?.at(-1));
    records.push({ pid, birth: row.birth, parentPid: row.ppid, parentApp, classification,
      ...(openFiles.length ? { protectedPaths: openFiles.map(file => file.path) } : {}),
      ...(claudeWriter ? { configIdentity: row.claudeConfig! } : {}),
      reason: openFiles.length ? 'protected_file_open_writer' : writer ? 'old_global_npm_writer' : consumer ? 'old_global_reference' : 'claude_config_writer',
      resolution: { action: classification === 'observation' ? 'observe' : writer ? 'finish-npm-operation' : 'close-process', instruction: classification === 'observation'
        ? `Claude Code PID ${pid} (parent ${parentApp}, PID ${row.ppid ?? 'unavailable'}) may update its configuration; recovery does not write it.` : writer
        ? `Let npm PID ${pid} (parent ${parentApp}, PID ${row.ppid ?? 'unavailable'}) finish, then retry.`
        : `Save work and close ${parentApp} (parent PID ${row.ppid ?? 'unavailable'}, consumer PID ${pid}), then retry.` } });
  }
  return { schema: 'caveat.global_process_preflight.v1' as const,
    status: counts.consumer || counts.writer ? 'stopped' as const : 'ready' as const, observedAt: new Date().toISOString(),
    consumers: counts.consumer, writers: counts.writer, unknown: counts.unreadable, counts, errors: tables.errors, records,
    residualRisks: globalProcessResidualRisks, existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
}

/** Collection injection belongs to isolated tests. Individual unreadable processes are counted. */
export async function preflightGlobalProcesses(scope: GlobalProcessScope, onEvent: (event: ProcessProbeEvent) => void = () => {}, collect = nativeGlobalProcessTables) {
  validateScope(scope);
  try { return assessGlobalProcesses(scope, await collect(onEvent, scope.protectedPaths)); }
  catch (error) {
    return { schema: 'caveat.global_process_preflight.v1' as const, status: 'stopped' as const,
      observedAt: new Date().toISOString(), consumers: null, writers: null, unknown: null, records: [], counts: null,
      residualRisks: globalProcessResidualRisks, errors: ['native_process_collection_failed'],
      resolution: { instruction: 'The process list could not be read. Check the process-list error and retry.' },
      errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'),
      existingProcessOperations: 0, filesystemWrites: 0, privilegeElevation: false as const };
  }
}
