import { WINDOWS_ACL_VERIFY, windowsAclApplyScript } from './privateWindowsAcl.js';

export const ACL_REPLY_BYTES = 64 * 1024;
export type AclOperation = { sequence: number; path: string; directory: boolean; apply: boolean };
export type AclReply = { sequence: number; ok: boolean; error?: string; terminal?: boolean; helperPid?: number };
export type AclWork = { operation: AclOperation | { sequence: number; close: true }; buffer: SharedArrayBuffer };

export function reply(work: AclWork, value: AclReply): void {
  const header = new Int32Array(work.buffer, 0, 2);
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > ACL_REPLY_BYTES) throw Error('ACL reply exceeds protocol bound');
  new Uint8Array(work.buffer, 8, data.length).set(data);
  Atomics.store(header, 1, data.length);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0);
}

/** Same apply + verify scripts as the synchronous runner, evaluated anew for
 * every request. Reuse only the interpreter, never an ACL decision. A rejection
 * exits this interpreter with the original code; the next request starts fresh. */
export function windowsAclSessionProgram(): string {
  // Call-operator script blocks have child scope. Force the same process exit
  // that the original one-shot interpreter used for a rejected ACL.
  const interpreterExit = (script: string) => script.replace(/\bexit (41|42|43)\b/g, '[Environment]::Exit($1)');
  return `$apply = { ${interpreterExit(windowsAclApplyScript())} }\n$verify = { ${interpreterExit(WINDOWS_ACL_VERIFY)} }\n` + String.raw`
$ErrorActionPreference='Stop'
while($null -ne ($line=[Console]::In.ReadLine())) {
  $r=ConvertFrom-Json -InputObject $line
  if(@($r.PSObject.Properties.Name).Count -ne 4 -or $r.path -isnot [string] -or $r.directory -isnot [bool] -or $r.apply -isnot [bool] -or $r.sequence -lt 1){exit 47}
  $env:CAVEAT_ACL_PATH=$r.path
  $env:CAVEAT_ACL_DIRECTORY=if($r.directory){'1'}else{'0'}
  if($r.apply){& $apply}else{& $verify}
  [Console]::Out.WriteLine(([ordered]@{sequence=$r.sequence;ok=$true}|ConvertTo-Json -Compress))
}
`;
}
