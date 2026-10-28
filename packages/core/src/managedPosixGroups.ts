import type { BigIntStats } from 'node:fs';

export type PosixGroup = { name: string; gid: number; members: string[] };
export type PosixGroupLookup = {
  user(uid: number): string | null;
  primaryUsers(gid: number): { uids: number[]; error?: string };
  group(gid: number): PosixGroup | null;
  namedGroup(name: string): PosixGroup | null;
};

/** NSS lookups, including directory services; never read the local group file directly. */
export async function nativePosixGroups(): Promise<PosixGroupLookup> {
  const koffi = await import('koffi'), lib = koffi.load(process.platform === 'darwin' ? null : 'libc.so.6');
  const groupType = koffi.struct({ name: 'str', password: 'str', gid: 'uint32_t', members: 'void *' });
  const byId = lib.func('int getgrgid_r(uint32_t gid, _Out_ void *record, _Out_ void *buffer, size_t size, _Out_ void **result)');
  const byName = lib.func('int getgrnam_r(const char *name, _Out_ void *record, _Out_ void *buffer, size_t size, _Out_ void **result)');
  const user = lib.func('int getpwuid_r(uint32_t uid, _Out_ void *record, _Out_ void *buffer, size_t size, _Out_ void **result)');
  const lookup = (call: (record: Buffer, buffer: Buffer, result: unknown[]) => number) => {
    // Linux and Darwin passwd records fit here; only the common first name pointer is decoded.
    const record = Buffer.alloc(256), buffer = Buffer.alloc(65536), result: unknown[] = [null];
    if (call(record, buffer, result) !== 0 || !result[0]) return null;
    return { record, buffer };
  };
  const readGroup = (call: Parameters<typeof lookup>[0]): PosixGroup | null => {
    const value = lookup(call); if (!value) return null;
    const decoded = koffi.decode(value.record, groupType) as { name: string; gid: number; members: unknown };
    if (!decoded.name || !decoded.members) return null;
    const members: string[] = [];
    for (let index = 0; index < 1024; index++) {
      const member = koffi.decode(decoded.members, index * koffi.sizeof('void *'), 'str') as string | null;
      if (member === null) return { name: decoded.name, gid: decoded.gid, members };
      members.push(member);
    }
    return null;
  };
  return {
    primaryUsers(gid) {
      const uids: number[] = [];
      try {
        const start = lib.func('void setpwent()'), end = lib.func('void endpwent()');
        const next = lib.func('int getpwent_r(_Out_ void *record, _Out_ void *buffer, size_t size, _Out_ void **result)');
        start();
        const record = Buffer.alloc(256), buffer = Buffer.alloc(65536);
        try {
          for (let index = 0; index <= 65536; index++) {
            const result: unknown[] = [null];
            koffi.errno(0); const code = Number(next(record, buffer, buffer.length, result)), errno = koffi.errno();
            if (!result[0] && (code === 0 || code === 2) && errno === 0) return { uids };
            if (code !== 0 || !result[0] || errno !== 0) return { uids, error: 'passwd_enumeration_failed_' + code + '_' + errno };
            if (index === 65536) return { uids, error: 'passwd_enumeration_bound' };
            if (record.readUInt32LE(20) === gid) uids.push(record.readUInt32LE(16));
          }
        } finally { end(); }
      } catch { return { uids, error: 'passwd_enumeration_unavailable' }; }
      return { uids, error: 'passwd_enumeration_bound' };
    },
    user(uid) { const value = lookup((record, buffer, result) => user(uid, record, buffer, buffer.length, result)); return value ? koffi.decode(value.record, 'str') as string : null; },
    group(gid) { return readGroup((record, buffer, result) => byId(gid, record, buffer, buffer.length, result)); },
    namedGroup(name) { return readGroup((record, buffer, result) => byName(name, record, buffer, buffer.length, result)); },
  };
}

export function posixParentGroup(stat: Pick<BigIntStats, 'mode' | 'gid'>, lookup: PosixGroupLookup,
  uid = process.geteuid!(), gid = process.getegid!(), platform = process.platform) {
  if ((stat.mode & 0o1000n) !== 0n || (stat.mode & 0o022n) === 0n) return { allowed: true, group: null };
  const group = lookup.group(Number(stat.gid));
  if ((stat.mode & 0o002n) !== 0n || !group || group.gid !== Number(stat.gid)) return { allowed: false, group: group?.name ?? null };
  if (platform === 'darwin' ? [0, 80].includes(group.gid)
    : ['root', 'sudo', 'wheel'].some(name => lookup.namedGroup(name)?.gid === group.gid)) return { allowed: true, group: group.name };
  const user = lookup.user(uid);
  if (stat.gid !== BigInt(gid) || user === null || group.name !== user || !group.members.every(member => member === user)) return { allowed: false, group: group.name };
  // shortcut: directory services that disable enumeration are not detected, upgrade when a host uses sssd/LDAP
  const primary = lookup.primaryUsers(gid);
  return { allowed: !primary.error && primary.uids.includes(uid) && primary.uids.every(value => value === uid), group: group.name, error: primary.error };
}
