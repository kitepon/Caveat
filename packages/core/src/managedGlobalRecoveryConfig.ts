import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, readlinkSync, statSync, type BigIntStats } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import assert from 'node:assert/strict';
import { isAbsolute, relative, sep, dirname, resolve } from 'node:path';
import { isWindows } from './platform.js';
import type { GlobalRecoverySnapshot } from './managedGlobalRecovery.js';

type Plan = GlobalRecoverySnapshot['plan'];
const key = (path: string) => isWindows() ? path.toLowerCase() : path;
export const recoveryPathContains = (parent: string, child: string) => {
  const name = relative(key(parent), key(child));
  return name === '' || !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep);
};
/** Resolve existing aliases without reading external setting contents. */
export function externalGlobalConfigPaths(paths: string[], owned: string[]) {
  const external = (path: string) => owned.every(root => !recoveryPathContains(root, path) && !recoveryPathContains(path, root));
  return [...new Set(paths.flatMap(path => {
    assert.ok(isAbsolute(path), 'global_config_absolute_path_required');
    let canonical = path;
    try { canonical = realpathSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return external(path) && external(canonical) ? [path, canonical] : [];
  }))].sort();
}
/** Only external input settings are observations. Active deployment, npm and globals remain strict. */
export function globalRecoveryConfigPaths(plan: Plan) {
  const owned = [plan.root, plan.globalRoot, plan.binDirectory, dirname(dirname(plan.baseline.npm.executable))];
  const external = (path: string) => owned.every(root => !recoveryPathContains(root, path) && !recoveryPathContains(path, root));
  if (plan.schema === 'caveat.global_migration_plan.v2') {
    assert.ok(Array.isArray(plan.configPaths) && plan.configPaths.length <= 64
      && plan.configPaths.every(path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && external(path)), 'global_config_owned_scope');
    assert.deepEqual([...new Set(plan.configPaths)].sort(), plan.configPaths, 'global_config_scope_invalid');
    return plan.configPaths;
  }
  const files = plan.baseline.protectedFiles.map(row => row.file)
    .filter(path => external(path) && external(plan.aliases.find(row => row.path === path)?.canonical ?? path));
  const aliases = plan.aliases.filter(row => files.includes(row.path) || files.includes(row.canonical));
  return [...new Set([...files, ...aliases.flatMap(row => [row.path, row.canonical]), ...plan.absences.map(row => row.path).filter(external)])].sort();
}
const metadata = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino),
  kind: stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'special',
  links: String(stat.nlink), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), mode: Number(stat.mode) });
const shaPath = (path: string) => createHash('sha256').update(path).digest('hex');
function observe(path: string) {
  try {
    const entry = lstatSync(path, { bigint: true });
    let canonical = entry.isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
    try { canonical = realpathSync(path); } catch { /* A dangling config link is still outside mutation scope. */ }
    let target: ReturnType<typeof metadata> | null = null;
    try { target = metadata(statSync(path, { bigint: true })); } catch { /* Record the entry even if its target is unavailable. */ }
    return { status: 'observed' as const, canonical, entry: metadata(entry), target };
  } catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' as const : 'unavailable' as const,
    code: (error as NodeJS.ErrnoException).code ?? 'config_observation_failed' }; }
}
const receipt = (state: ReturnType<typeof observe>) => {
  if (state.status !== 'observed') return state;
  const { canonical, ...rest } = state; return { ...rest, canonicalSha256: shaPath(canonical) };
};
/** Metadata only; no retained write/delete exclusion handle and no setting contents enter evidence. */
export function observeGlobalRecoveryConfigs(paths: string[]) {
  const records = paths.map(path => { const before = observe(path); return { path, before, after: before, changes: 0, writerPids: [] as number[] }; });
  return {
    observe() { for (const row of records) { const after = observe(row.path); if (!isDeepStrictEqual(after, row.after)) row.changes++; row.after = after; } },
    writers(writers: { pid: number; configIdentity?: { dev: string; ino: string } }[]) {
      for (const row of records) {
        const identities = [row.before, row.after].flatMap(state => state.status === 'observed' && state.target ? [state.target] : []);
        const pids = writers.filter(writer => identities.some(id => id.dev === writer.configIdentity?.dev && id.ino === writer.configIdentity?.ino)).map(row => row.pid);
        row.writerPids = [...new Set([...row.writerPids, ...pids])].slice(0, 100000);
      }
    },
    records() { return records.map(row => ({ pathSha256: shaPath(row.path), before: receipt(row.before), after: receipt(row.after), changes: row.changes, writerPids: [...row.writerPids] })); },
    paths() { return [...paths, ...records.flatMap(row => row.after.status === 'observed' ? [row.after.canonical] : [])]; },
    identities() { return records.flatMap(row => [row.before, row.after].flatMap(state => state.status === 'observed' ? [state.entry, ...(state.target ? [state.target] : [])] : [])); },
  };
}
export type GlobalRecoveryConfigState = ReturnType<typeof observeGlobalRecoveryConfigs>;
