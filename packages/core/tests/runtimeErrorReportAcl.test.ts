import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWindowsCredentialAcl } from '../src/runtimeErrorReport.js';

it.skipIf(process.platform !== 'win32')('PowerShell 7で、本人・SYSTEM・Administrators以外が読めるcredentialを拒否する', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'caveat-credential-acl-'));
  try {
    const path = join(root, 'caveat.json');
    writeFileSync(path, '{}');
    // ユーザープロファイル配下の既定の継承ACLは受ける。
    runWindowsCredentialAcl(path);
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`$ErrorActionPreference='Stop';$p=$env:CAVEAT_ACL_TEST_PATH;$acl=Get-Acl -LiteralPath $p;$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow');$acl.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $acl`], { env: { ...process.env, CAVEAT_ACL_TEST_PATH: path }, encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(() => runWindowsCredentialAcl(path)).toThrow(/credential_unsafe: powershell exit=44/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
