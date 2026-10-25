import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isWindows } from '../src/platform.js';
import { activateManagedDeployment, stageManagedDeployment, readManagedDeployment, managedRegistrationPath, managedDeploymentPaths, verifyManagedDeployment, managedInstallerLockStatus, recoverManagedInstallerLock } from '../src/managedDeployment.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'caveat-managed-')); roots.push(root);
  const userHome = join(root, 'profile'); mkdirSync(userHome, { mode: 0o700 });
  // These are semantic store fixtures, not native Windows ACL acceptance.
  const options = { userHome, aclRunner: () => {}, aclTreeRunner: () => {}, aclVerifyTreeRunner: () => {} };
  const source = (version: string) => {
    const dir = join(root, version); mkdirSync(join(dir, 'dist'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'caveat-cli', version, bin: { caveat: 'dist/caveat.js' } }));
    writeFileSync(join(dir, 'dist', 'caveat.js'), `console.log(${JSON.stringify(version)});\n`);
    writeFileSync(join(dir, 'dist', 'stable-entry.mjs'), '// immutable v1 entry\n');
    writeFileSync(join(dir, 'dist', 'managed-deployment.js'), '// immutable v1 runtime\n');
    return dir;
  };
  return { root, source, options, paths: managedDeploymentPaths(userHome) };
}
describe('managed deployment transaction and protected payload', () => {
  it('switches and rolls back releases without rewriting the entry or a registration path', () => {
    const f = fixture(), a = stageManagedDeployment(f.source('1.0.0'), f.options), b = stageManagedDeployment(f.source('1.0.1'), f.options);
    activateManagedDeployment(a.release, f.options);
    const entry = readFileSync(f.paths.launcher), runtime = readFileSync(f.paths.runtime);
    expect(managedRegistrationPath('/some/npm/bin/caveat', f.options)).toBe(f.paths.launcher);
    expect(activateManagedDeployment(b.release, f.options).previousRelease).toBe(a.release);
    expect(readManagedDeployment(f.options).manifest.version).toBe('1.0.1');
    expect(readFileSync(f.paths.launcher)).toEqual(entry); expect(readFileSync(f.paths.runtime)).toEqual(runtime);
    activateManagedDeployment(a.release, f.options);
    expect(readManagedDeployment(f.options).manifest.version).toBe('1.0.0');
    expect(managedRegistrationPath('/different/version/bin/caveat', f.options)).toBe(f.paths.launcher);
  });
  it('keeps the active pointer when a target is corrupted or another installer holds the lock', () => {
    const f = fixture(), a = stageManagedDeployment(f.source('1.0.0'), f.options), b = stageManagedDeployment(f.source('1.0.1'), f.options);
    activateManagedDeployment(a.release, f.options); const old = readFileSync(f.paths.pointer);
    writeFileSync(join(f.paths.releases, b.release, 'package', 'dist', 'caveat.js'), 'changed');
    expect(() => activateManagedDeployment(b.release, f.options)).toThrow('payload_changed');
    expect(readFileSync(f.paths.pointer)).toEqual(old);
    writeFileSync(f.paths.lock, 'another installer', { flag: 'wx', mode: 0o600 });
    expect(() => activateManagedDeployment(a.release, f.options)).toThrow('installer_busy');
    expect(readFileSync(f.paths.pointer)).toEqual(old);
  });
  it('rejects changed entry bytes and manifest traversal before changing the selected release', () => {
    const f = fixture(), source = f.source('1.0.0'), a = stageManagedDeployment(source, f.options);
    activateManagedDeployment(a.release, f.options); const old = readFileSync(f.paths.pointer);
    const other = f.source('1.0.1'); writeFileSync(join(other, 'dist', 'stable-entry.mjs'), '// replaced entry\n');
    expect(() => stageManagedDeployment(other, f.options)).toThrow('entry_upgrade_requires_migration');
    expect(readFileSync(f.paths.pointer)).toEqual(old);
    expect(() => activateManagedDeployment('../outside', f.options)).toThrow('invalid_release');
    writeFileSync(f.paths.pointer, JSON.stringify({ schema: 1, release: '../outside', manifestSha256: 'a'.repeat(64) }));
    expect(() => readManagedDeployment(f.options)).toThrow('invalid_pointer');
  });
  it('can stage a prior npm version using the same installer-owned entry protocol', () => {
    const f = fixture(), installer = f.source('1.0.1'), old = f.source('1.0.0');
    rmSync(join(old, 'dist', 'stable-entry.mjs')); rmSync(join(old, 'dist', 'managed-deployment.js'));
    const staged = stageManagedDeployment(old, { ...f.options, entrySourceRoot: installer });
    activateManagedDeployment(staged.release, f.options);
    expect(readManagedDeployment(f.options).manifest.version).toBe('1.0.0');
  });
  it('requires explicit recovery of a damaged pointer and still verifies the replacement payload', () => {
    const f = fixture(), a = stageManagedDeployment(f.source('1.0.0'), f.options);
    activateManagedDeployment(a.release, f.options);
    writeFileSync(f.paths.pointer, '{damaged');
    expect(() => activateManagedDeployment(a.release, f.options)).toThrow();
    expect(readFileSync(f.paths.pointer, 'utf8')).toBe('{damaged');
    expect(activateManagedDeployment(a.release, { ...f.options, recoverInvalidPointer: true }).previousRelease).toBe(null);
    expect(readManagedDeployment(f.options).manifest.version).toBe('1.0.0');
  });
  it.skipIf(isWindows())('rejects a link in an existing root and a writable ancestor without repairing their permissions', () => {
    const f = fixture(), source = f.source('1.0.0');
    mkdirSync(join(f.options.userHome, '.local'), { mode: 0o700 });
    chmodSync(join(f.options.userHome, '.local'), 0o777);
    expect(() => stageManagedDeployment(source, f.options)).toThrow('unsafe_owner_or_mode');
    chmodSync(join(f.options.userHome, '.local'), 0o700);
    const outside = join(f.root, 'outside'); mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(f.options.userHome, '.local', 'share'));
    expect(() => stageManagedDeployment(source, f.options)).toThrow('unsafe_path');
    expect(existsSync(join(outside, 'caveat'))).toBe(false);
  });
  it.skipIf(isWindows())('accepts an OS-level parent alias while keeping the managed entry canonical', () => {
    const f=fixture(), alias=join(f.root,'parent-alias');symlinkSync(f.root,alias);
    const options={...f.options,userHome:join(alias,'profile')};
    const staged=stageManagedDeployment(f.source('1.0.0'),options);
    activateManagedDeployment(staged.release,options);
    expect(readManagedDeployment(options).manifest.version).toBe('1.0.0');
    expect(staged.launcher).toBe(f.paths.launcher);
  });
  it('keeps startup independent of ACL processes and payload scans, while status detects changed payloads', () => {
    const f=fixture(), a=stageManagedDeployment(f.source('1.0.0'),f.options);
    activateManagedDeployment(a.release,f.options);
    const noAcl={...f.options,windows:true,aclRunner:()=>{throw Error('ACL must not run at startup');}};
    expect(readManagedDeployment(noAcl).manifest.version).toBe('1.0.0');
    writeFileSync(join(f.paths.releases,a.release,'package','package.json'),'changed payload');
    expect(readManagedDeployment(noAcl).manifest.version).toBe('1.0.0');
    expect(()=>verifyManagedDeployment(f.options)).toThrow('payload_changed');
    const manifest=join(f.paths.releases,a.release,'manifest.json');writeFileSync(manifest,'changed manifest');
    expect(()=>readManagedDeployment(noAcl)).toThrow('manifest_changed');
  });
  it.skipIf(isWindows())('still rejects writable runtime metadata and redirected entry or CLI paths at startup', () => {
    const f=fixture(), a=stageManagedDeployment(f.source('1.0.0'),f.options);activateManagedDeployment(a.release,f.options);
    for(const path of [f.paths.root,f.paths.entry,f.paths.pointer,join(f.paths.releases,a.release),join(f.paths.releases,a.release,'manifest.json')]){
      chmodSync(path,0o777);expect(()=>readManagedDeployment(f.options)).toThrow('unsafe_owner_or_mode');chmodSync(path,path===f.paths.pointer||path.endsWith('manifest.json')?0o600:0o700);
    }
    const original=readFileSync(f.paths.launcher), outside=join(f.root,'entry-outside');writeFileSync(outside,original);rmSync(f.paths.launcher);symlinkSync(outside,f.paths.launcher);
    expect(()=>readManagedDeployment(f.options)).toThrow('unsafe_path');
    rmSync(f.paths.launcher);writeFileSync(f.paths.launcher,original,{mode:0o600});
    const cli=join(f.paths.releases,a.release,'package','dist','caveat.js');rmSync(cli);symlinkSync(outside,cli);
    expect(()=>readManagedDeployment(f.options)).toThrow('unsafe_path');
  });
  it('diagnoses a held or abandoned lock and recovers only an explicitly confirmed absent owner', () => {
    const f=fixture(), a=stageManagedDeployment(f.source('1.0.0'),f.options);activateManagedDeployment(a.release,f.options);
    const before=readFileSync(f.paths.pointer), startedAt=new Date().toISOString();
    writeFileSync(f.paths.lock,JSON.stringify({schema:1,pid:process.pid,startedAt}),{flag:'wx',mode:0o600});
    expect(managedInstallerLockStatus(f.options)).toEqual({state:'busy',pid:process.pid,startedAt});
    expect(()=>recoverManagedInstallerLock(f.options)).toThrow('installer_busy');expect(readFileSync(f.paths.pointer)).toEqual(before);
    const exited=spawnSync(process.execPath,['-e',''],{timeout:5000});expect(exited.status).toBe(0);
    writeFileSync(f.paths.lock,JSON.stringify({schema:1,pid:exited.pid,startedAt}));
    expect(managedInstallerLockStatus(f.options).state).toBe('stale');
    expect(recoverManagedInstallerLock(f.options)).toEqual({removed:true,previousPid:exited.pid,startedAt});
    expect(readFileSync(f.paths.pointer)).toEqual(before);expect(managedInstallerLockStatus(f.options).state).toBe('absent');
    writeFileSync(f.paths.lock,'malformed',{flag:'wx',mode:0o600});
    expect(()=>recoverManagedInstallerLock(f.options)).toThrow('lock_invalid');expect(existsSync(f.paths.lock)).toBe(true);
  });

});
