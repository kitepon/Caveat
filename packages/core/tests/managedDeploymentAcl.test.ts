import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runWindowsAcl, runWindowsManagedRootAcl, runWindowsManagedSourceAcl } from '../src/privateWindowsAcl.js';

it.skipIf(process.platform !== 'win32')('rejects ordinary-user writes to a prospective ancestor, source or existing managed root', { timeout: 60_000 }, () => {
  const owned = mkdtempSync(join(tmpdir(), 'caveat-managed-acl-'));
  const home = join(owned, 'profile'), root = join(home, '.caveat-deploy', 'managed-v1');
  mkdirSync(home); runWindowsAcl(home, true, true);
  function allowUsers(path: string, rights: string) {
    const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference='Stop'
$p=$env:CAVEAT_TEST_PATH
$acl=Get-Acl -LiteralPath $p
$users=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,$env:CAVEAT_TEST_RIGHTS,'Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($p),$acl)
`], { env: { ...process.env, CAVEAT_TEST_PATH: path, CAVEAT_TEST_RIGHTS: rights }, encoding: 'utf8', timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
  }
  try {
    expect(() => runWindowsManagedRootAcl(root, home, true)).not.toThrow();
    allowUsers(home, 'Write');
    expect(() => runWindowsManagedRootAcl(root, home, true)).toThrow('exit=43');
    // Only this test-owned fixture is restored, never an existing user root.
    runWindowsAcl(home, true, true);
    const source = join(owned, 'source'); mkdirSync(source); runWindowsAcl(source, true, true);
    writeFileSync(join(source, 'package.json'), '{}');
    expect(() => runWindowsManagedSourceAcl(source)).not.toThrow();
    allowUsers(source, 'Write');
    expect(() => runWindowsManagedSourceAcl(source)).toThrow('exit=43');
    mkdirSync(root, { recursive: true }); runWindowsAcl(root, true, true);
    allowUsers(root, 'Read');
    expect(() => runWindowsManagedRootAcl(root, home)).toThrow('exit=42');
  } finally { rmSync(owned, { recursive: true, force: true }); }
});
