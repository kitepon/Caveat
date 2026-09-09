import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWindowsAcl } from '../src/runtimeErrors.js';

it.skipIf(process.platform !== 'win32')('PowerShell 7で所有者だけのACLを適用し、追加した第三者の権限を拒否する', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-acl-'));
  try {
    runWindowsAcl(root, true, true);
    runWindowsAcl(root, true, false);
    const path = join(root, 'state.json');
    writeFileSync(path, '{}');
    runWindowsAcl(path, false, true);
    runWindowsAcl(path, false, false);
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`$ErrorActionPreference='Stop';$p=$env:CAVEAT_ACL_TEST_PATH;$acl=Get-Acl -LiteralPath $p;$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl`], { env: { ...process.env, CAVEAT_ACL_TEST_PATH: path }, encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(() => runWindowsAcl(path, false, false)).toThrow(/store_unsafe: powershell exit=42/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
