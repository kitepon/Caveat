import { spawnSync } from 'node:child_process';

const WINDOWS_ACL_VERIFY = String.raw`$ErrorActionPreference='Stop';$p=$env:CAVEAT_ACL_PATH;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $p;$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;if($owner -ne $sid){exit 41};$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));if($rules.Count -ne 1){exit 42};$r=$rules[0];if($r.IdentityReference.Value -ne $sid -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited -or ($r.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){exit 43}`;
// Persist only modified owner/access sections; Set-Acl may copy the audit
// section and require SeSecurityPrivilege even for a DACL-only change.
function windowsAclApplyScript() { return String.raw`$ErrorActionPreference='Stop';$p=$env:CAVEAT_ACL_PATH;$isDir=$env:CAVEAT_ACL_DIRECTORY -eq '1';$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=if($isDir){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity};$acl.SetAccessRuleProtection($true,$false);$flags=if($isDir){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None};$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$acl.SetOwner($sid);$acl.AddAccessRule($rule);if($isDir){[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($p),$acl)}else{[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($p),$acl)};` + WINDOWS_ACL_VERIFY; }
// Hang guard, not a latency budget, and sized against the slowest machine that
// runs it rather than a developer box.
//
// The old 3s bound is what made this seam flake: on a contended Windows CI
// runner a single apply can cross it, spawnSync kills powershell,
// and the null exit status read as "unsafe ACL". Measured on the actual
// runners, one apply costs 331-459ms across 160 isolated runs, but the same
// test costs 1042-1319ms inside the full parallel suite and the file it lives
// in takes 47-61s overall — so 3s left barely 2.5x headroom against a runner
// under load. A later windows-2022 run exhausted the former 15s guard while
// PowerShell was starting, without returning an ACL rejection. 30s remains a
// bounded hang guard while giving the hosted runner cold start enough room.
// Re-measure before changing it; a fast idle box will lie to you.
const WINDOWS_ACL_TIMEOUT_MS = 30_000;
export function runWindowsAcl(path: string, directory: boolean, apply: boolean) {
  runAclScript(path, directory, apply ? windowsAclApplyScript() : WINDOWS_ACL_VERIFY);
}
/** CopyFile can retain source security; seal every staged descendant in one process. */
export function runWindowsAclPrivateTree(path: string) {
  const script = String.raw`$ErrorActionPreference='Stop';$items=@(Get-Item -LiteralPath $env:CAVEAT_ACL_PATH)+@(Get-ChildItem -LiteralPath $env:CAVEAT_ACL_PATH -Force -Recurse);foreach($item in $items){if($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint){exit 44};$env:CAVEAT_ACL_PATH=$item.FullName;$env:CAVEAT_ACL_DIRECTORY=if($item.PSIsContainer){'1'}else{'0'};` + windowsAclApplyScript() + '}';
  runAclScript(path, true, script);
}
/** Full installer/status recheck, never called by a hook's stable entry. */
export function runWindowsAclVerifyPrivateTree(path: string, additionalPaths: string[] = []) {
  // Inherited owner-only rules are equally private below the independently
  // verified root. Reject additional principals, reparse points and foreign owners.
  const verify = WINDOWS_ACL_VERIFY.replace(' -or $r.IsInherited', '');
  const script = String.raw`$ErrorActionPreference='Stop';foreach($root in (ConvertFrom-Json $env:CAVEAT_ACL_VERIFY_PATHS)){$item=Get-Item -LiteralPath $root -Force;$items=@($item);if($item.PSIsContainer){$items+=@(Get-ChildItem -LiteralPath $root -Force -Recurse)};foreach($item in $items){if($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint){exit 44};$env:CAVEAT_ACL_PATH=$item.FullName;` + verify + '}}';
  runAclScript(path, true, script, { CAVEAT_ACL_VERIFY_PATHS: JSON.stringify([path, ...additionalPaths]) });
}
/** Ancestors must not let another ordinary user replace an owner-only root. */
export function runWindowsManagedRootAcl(path: string, userHome: string) {
  const script = String.raw`$ErrorActionPreference='Stop';$root=[System.IO.Path]::GetFullPath($env:CAVEAT_ACL_PATH);$homePath=[System.IO.Path]::GetFullPath($env:CAVEAT_DEPLOY_HOME);$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$current=$root;$mask=[System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership';while($true){if(Test-Path -LiteralPath $current){$item=Get-Item -LiteralPath $current -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)){exit 44};$acl=Get-Acl -LiteralPath $current;if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 41};foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $mask) -ne 0 -and $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544','S-1-3-0')){exit 43}}};if($current.Equals($homePath,[System.StringComparison]::OrdinalIgnoreCase)){break};$next=[System.IO.Path]::GetDirectoryName($current);if(-not $next -or $next.Length -lt $homePath.Length){exit 45};$current=$next};if(Test-Path -LiteralPath $root){$env:CAVEAT_ACL_PATH=$root;` + WINDOWS_ACL_VERIFY + '}';
  runAclScript(path, true, script, { CAVEAT_DEPLOY_HOME: userHome });
}
function runAclScript(path: string, directory: boolean, script: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...extraEnv, CAVEAT_ACL_PATH: path, CAVEAT_ACL_DIRECTORY: directory ? '1' : '0' }, encoding: 'utf-8', timeout: WINDOWS_ACL_TIMEOUT_MS, windowsHide: true });
  // 起動失敗・timeout・ACL拒否を区別し、外向きのstore_unsafeにはcauseとして保持する。
  // pathとstderrは内部診断だけに残し、収集レコードには保存しない。
  if (result.error !== undefined) throw Error(`store_unsafe: powershell spawn ${(result.error as NodeJS.ErrnoException).code ?? result.error.message}`);
  if (result.status !== 0) throw Error(`store_unsafe: powershell exit=${result.status} signal=${result.signal ?? 'none'} stderr=${(result.stderr ?? '').replace(/\s+/g, ' ').trim().slice(0, 400) || '(empty)'}`);
}
