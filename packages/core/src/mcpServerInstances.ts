import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import semver from 'semver';
import { nativeGlobalProcessTables, type NativeProcessTables } from './managedProcessNative.js';
import { processAppName } from './managedGlobalProcesses.js';

/** The running server records its loaded product version, even if its installation is later replaced. */
export function registerMcpServerInstance(home: string, version: string, birth: string) {
  if (!semver.valid(version) || !birth) throw Error('mcp_instance_identity_invalid');
  const directory = join(home, 'mcp-servers'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory); if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('mcp_instance_directory_invalid');
  const path = join(directory, process.pid + '-' + randomUUID() + '.json');
  writeFileSync(path, JSON.stringify({ schema: 1, pid: process.pid, birth, version }) + '\n', { flag: 'wx', mode: 0o600 });
  const original = lstatSync(path);
  return () => { try { const current = lstatSync(path); if (current.dev === original.dev && current.ino === original.ino && !current.isSymbolicLink()) unlinkSync(path); } catch { /* An absent receipt needs no cleanup. */ } };
}
// Win32_Process rounds native 100ns FILETIME to microseconds.
const birthKey = (value: string | null) => value?.replace(/(\.\d{6})\dZ$/, '$1Z');
function installationVersion(script: string) {
  if (!isAbsolute(script) || !/(?:^|[\\/])(?:caveat|index)\.(?:m?js|cjs)$/.test(script)) return null;
  let directory = dirname(script);
  for (let depth = 0; depth < 5; depth++) {
    try {
      const path = join(directory, 'package.json'), stat = lstatSync(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536) {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.name === 'caveat-cli' && semver.valid(value.version)) return value.version as string;
      }
    } catch { /* A non-package directory is not a process-reading failure. */ }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  return null;
}
export function staleMcpServersFromTable(home: string, targetVersion: string, tables: NativeProcessTables) {
  const receipts = new Map<string, string>(), directory = join(home, 'mcp-servers');
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of readdirSync(directory).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).slice(0, 4096)) {
      try {
        const path = join(directory, name), stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.schema === 1 && Number.isSafeInteger(value.pid) && typeof value.birth === 'string' && semver.valid(value.version)) receipts.set(value.pid + ':' + birthKey(value.birth), value.version);
      } catch { /* Invalid or expired receipts never identify an active server. */ }
    }
  }
  const rows = new Map([...tables.before, ...tables.after].map(row => [row.pid, row]));
  const servers = [];
  for (const row of tables.after) {
    if (!row.argv?.includes('mcp-server')) continue;
    const loaded = receipts.get(row.pid + ':' + birthKey(row.birth)), version = loaded ?? row.argv.map(installationVersion).find(Boolean);
    if (!version || !semver.valid(targetVersion) || !semver.lt(version, targetVersion)) continue;
    const parentApp = processAppName(rows.get(row.ppid ?? -1));
    servers.push({ pid: row.pid, parentPid: row.ppid, parentApp, version, versionSource: loaded ? 'loaded-server-receipt' : 'old-installation',
      instruction: `Old Caveat ${version}, PID ${row.pid}, parent ${parentApp} (PID ${row.ppid ?? 'unavailable'}). Reopen that client to use ${targetVersion}.` });
  }
  return { status: 'observed' as const, staleServers: servers, unreadableProcesses: [...rows.values()].filter(row => !row.argv).length,
    existingProcessOperations: 0, filesystemWrites: 0 };
}
export async function staleMcpServers(home: string, targetVersion: string) {
  try { return staleMcpServersFromTable(home, targetVersion, await nativeGlobalProcessTables()); }
  catch { return { status: 'unavailable' as const, staleServers: [], instruction: 'Process information could not be read. Reopen the AI client if it still uses the old Caveat version.', existingProcessOperations: 0, filesystemWrites: 0 }; }
}
