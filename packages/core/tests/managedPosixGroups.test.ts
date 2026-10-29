import { describe, it, expect } from 'vitest';
import { userInfo } from 'node:os';
import { nativePosixGroups, posixParentGroup, passwdEnumerationState, type PosixGroupLookup } from '../src/managedPosixGroups.js';
const own = { name: 'alice', gid: 1000, members: [] as string[] };
const lookup = (changes: Partial<PosixGroupLookup> = {}): PosixGroupLookup => ({ user: () => 'alice', group: () => own,
  namedGroup: () => null, primaryUsers: () => ({ uids: [1000] }), ...changes });
const check = (mode: bigint, data = lookup(), platform: NodeJS.Platform = 'linux', gid = 1000n) => posixParentGroup({ mode, gid }, data, 1000, 1000, platform);
describe('POSIX parent writers', () => {
  it('accepts a private group with no supplementary members', () => expect(check(0o775n).allowed).toBe(true));
  it('rejects another supplementary member', () => expect(check(0o775n, lookup({ group: () => ({ ...own, members: ['bob'] }) })).allowed).toBe(false));
  it('rejects another primary member', () => expect(check(0o775n, lookup({ primaryUsers: () => ({ uids: [1000, 1001] }) })).allowed).toBe(false));
  it('rejects unavailable or bounded enumeration', () => expect(check(0o775n, lookup({ primaryUsers: () => ({ uids: [], error: 'bound' }) })).allowed).toBe(false));
  it('rejects world write', () => expect(check(0o777n).allowed).toBe(false));
  it('retains sticky treatment', () => expect(check(0o1777n).allowed).toBe(true));
  it('rejects an unknown group', () => expect(check(0o775n, lookup({ group: () => null })).allowed).toBe(false));
  it('accepts sudo by resolved gid without enumerating users', () => expect(check(0o775n, lookup({ group: () => ({ name: 'sudo', gid: 27, members: ['bob'] }), namedGroup: name => name === 'sudo' ? { name, gid: 27, members: [] } : null, primaryUsers: () => { throw Error('must not enumerate'); } }), 'linux', 27n).allowed).toBe(true));
  it('accepts Darwin admin without enumerating users', () => expect(check(0o775n, lookup({ group: () => ({ name: 'admin', gid: 80, members: ['bob'] }), primaryUsers: () => { throw Error('must not enumerate'); } }), 'darwin', 80n).allowed).toBe(true));
  it('rejects an unrelated effective gid', () => expect(check(0o775n, lookup(), 'linux', 1001n).allowed).toBe(false));
  it.skipIf(process.platform !== 'linux')('reads native NSS user/group and primary members', async () => {
    const data = await nativePosixGroups(), uid = process.geteuid!(), gid = process.getegid!();
    expect(data.user(uid)).toBe(userInfo().username); expect(data.group(gid)?.gid).toBe(gid);
    expect(data.primaryUsers(gid)).toEqual({ uids: expect.arrayContaining([uid]) });
  });
});

describe('passwd enumeration result', () => {
  it.each([0, 2])('accepts ENOENT end with errno %s', errno => expect(passwdEnumerationState(2, false, errno)).toBe('end'));
  it('accepts a zero-code empty end', () => expect(passwdEnumerationState(0, false, 2)).toBe('end'));
  it('rejects another native error', () => expect(passwdEnumerationState(5, false, 5)).toBe('error'));
  it('rejects errno accompanying an entry', () => expect(passwdEnumerationState(0, true, 2)).toBe('error'));
  it('accepts a clean entry', () => expect(passwdEnumerationState(0, true, 0)).toBe('entry'));
});
