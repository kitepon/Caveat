import assert from 'node:assert/strict';
import { collectNativeGlobalProcesses } from './platform.js';
import { ownedProcessProbe, type ProcessProbeEvent, type ProcessProbeRun } from './managedProcessNative.js';

export type WindowsResourceObservation = {
  schema: 'caveat.windows_resources.v1'; files: number; stage: 'start' | 'register' | 'list' | 'list-bound' | 'complete'; code: number;
  endCode: number | null; rebootReasons: number; observerAdministrator: boolean; regularFiles: number; directories: number;
  users: { pid: number; birth: string; type: number; service: boolean; session: number }[];
};

// Only session registration/query/end are imported. This bridge cannot stop or restart an application.
export const WINDOWS_RESOURCE_QUERY = String.raw`$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$inputValue=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$files=[string[]]@($inputValue.files)
if($files.Count -lt 1 -or $files.Count -gt 10000){throw 'resource_count_bound'}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CaveatResources {
  [StructLayout(LayoutKind.Sequential)] struct UniqueProcess { public uint Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string Service;
    public uint Type; public uint Status; public uint Session;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session,uint flags,StringBuilder key);
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session,uint count,[In,MarshalAs(UnmanagedType.LPArray,ArraySubType=UnmanagedType.LPWStr)] string[] files,uint apps,IntPtr processes,uint services,IntPtr names);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session,out uint needed,ref uint count,[In,Out] ProcessInfo[] processes,ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  public sealed class User { public uint pid; public string birth; public uint type; public bool service; public uint session; }
  public sealed class Result {
    public string schema="caveat.windows_resources.v1"; public int files; public int regularFiles; public int directories; public string stage; public int code; public int? endCode;
    public bool observerAdministrator=new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
    public uint rebootReasons; public List<User> users=new List<User>();
  }
  public static Result Query(string[] files) {
    var result=new Result { files=files.Length, stage="start" }; uint handle;
    foreach(var file in files) { if(System.IO.File.Exists(file)) result.regularFiles++; if(System.IO.Directory.Exists(file)) result.directories++; }
    result.code=RmStartSession(out handle,0,new StringBuilder(33)); if(result.code!=0) return result;
    try {
      result.stage="register"; result.code=RmRegisterResources(handle,(uint)files.Length,files,0,IntPtr.Zero,0,IntPtr.Zero);
      if(result.code!=0) return result;
      for(int attempt=0;attempt<4;attempt++) {
        uint needed=0,count=0,reasons=0; result.stage="list";
        result.code=RmGetList(handle,out needed,ref count,null,ref reasons); result.rebootReasons=reasons;
        if(result.code==0) { result.stage="complete"; return result; }
        if(result.code!=234) return result;
        if(needed==0 || needed>4096) { result.stage="list-bound"; return result; }
        var processes=new ProcessInfo[needed]; count=needed;
        result.code=RmGetList(handle,out needed,ref count,processes,ref reasons); result.rebootReasons=reasons;
        if(result.code==234) continue; if(result.code!=0) return result;
        if(count>processes.Length) throw new InvalidOperationException("resource_count_invalid");
        for(int index=0;index<count;index++) {
          var process=processes[index]; var time=process.Process.Started;
          long birth=unchecked((long)(((ulong)(uint)time.dwHighDateTime<<32)|(uint)time.dwLowDateTime));
          result.users.Add(new User {pid=process.Process.Pid,birth=DateTime.FromFileTimeUtc(birth).ToString("O"),type=process.Type,service=!String.IsNullOrEmpty(process.Service),session=process.Session});
        }
        result.stage="complete"; return result;
      }
      result.stage="list-bound"; return result;
    } finally { result.endCode=RmEndSession(handle); }
  }
}
'@
[CaveatResources]::Query($files) | ConvertTo-Json -Compress -Depth 6
`;

export function decodeWindowsResourceObservation(stdout: string, files: number): WindowsResourceObservation {
  assert.ok(Buffer.byteLength(stdout) <= 1024 * 1024, 'windows_resource_output_bound');
  const result = JSON.parse(stdout) as WindowsResourceObservation;
  assert.equal(Object.keys(result).sort().join(','), 'code,directories,endCode,files,observerAdministrator,rebootReasons,regularFiles,schema,stage,users');
  assert.ok(result.schema === 'caveat.windows_resources.v1' && result.files === files && ['start', 'register', 'list', 'list-bound', 'complete'].includes(result.stage), 'windows_resource_protocol_invalid');
  assert.ok(Number.isSafeInteger(result.code) && result.code >= 0 && (result.endCode === null || Number.isSafeInteger(result.endCode) && result.endCode >= 0) && Number.isSafeInteger(result.rebootReasons) && result.rebootReasons >= 0 && result.rebootReasons <= 0xffffffff && typeof result.observerAdministrator === 'boolean', 'windows_resource_code_invalid');
  assert.ok(Array.isArray(result.users) && result.users.length <= 4096, 'windows_resource_users_bound');
  assert.ok(Number.isSafeInteger(result.regularFiles) && result.regularFiles >= 0 && Number.isSafeInteger(result.directories) && result.directories >= 0 && result.regularFiles + result.directories <= files, 'windows_resource_file_kinds_invalid');
  const identities = new Set<string>();
  for (const user of result.users) {
    assert.equal(Object.keys(user).sort().join(','), 'birth,pid,service,session,type');
    assert.ok(Number.isSafeInteger(user.pid) && user.pid > 0 && typeof user.birth === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(user.birth) && Number.isFinite(Date.parse(user.birth)), 'windows_resource_identity_invalid');
    assert.ok(Number.isSafeInteger(user.type) && [0, 1, 2, 3, 4, 5, 1000].includes(user.type) && typeof user.service === 'boolean' && Number.isSafeInteger(user.session) && user.session >= 0 && user.session <= 0xffffffff, 'windows_resource_user_invalid');
    const key = user.pid + ':' + user.birth; assert.ok(!identities.has(key), 'windows_resource_duplicate_identity'); identities.add(key);
  }
  assert.ok(result.stage !== 'complete' || result.code === 0 && result.endCode === 0, 'windows_resource_session_not_closed');
  return result;
}

/** Used for native qualification until cross-context coverage has been demonstrated. */
export async function readWindowsResourceUsers(command: string, files: string[], onEvent: (event: ProcessProbeEvent) => void = () => {}, run?: ProcessProbeRun) {
  assert.ok(files.length > 0 && files.length <= 10000 && new Set(files).size === files.length && files.every(path => /^[A-Za-z]:[\\/]/.test(path) && !/[\x00-\x1f]/.test(path)), 'windows_resource_paths_invalid');
  const input = Buffer.from(JSON.stringify({ files }));
  const probe = run ?? ownedProcessProbe(onEvent, { input, outputLimit: 1024 * 1024 });
  const result = await probe(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_RESOURCE_QUERY, 'utf16le').toString('base64')], 'windows-resources', Date.now() + 20000);
  return decodeWindowsResourceObservation(result.stdout, files.length);
}
export function nativeWindowsResourceUsers(files: string[], onEvent: (event: ProcessProbeEvent) => void = () => {}) {
  const unsupported = (): Promise<WindowsResourceObservation> => { throw Error('windows_resource_platform_required'); };
  return collectNativeGlobalProcesses({ linux: unsupported, darwin: unsupported, win32: command => readWindowsResourceUsers(command, files, onEvent) });
}
