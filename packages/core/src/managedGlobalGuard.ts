import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, parse, relative, sep } from 'node:path';
import { globalFilesystemNativeSpec } from './platform.js';
import { createPosixGlobalGuard } from './managedPosixGuard.js';
import { createWindowsGlobalGuard } from './managedWindowsGuard.js';

export type GlobalGuardIdentity = {
  dev: string; ino: string; kind: 'file' | 'directory' | 'link';
  size: string; links: string; mtime: string; ctime: string;
  owner: string; group: string; mode: number; securitySha256?: string; contentSha256?: string;
};
export type NativeGuardDriver = {
  openRoot(path: string): object;
  openChild(parent: object, name: string, purpose: 'parent' | 'observe' | 'mutation'): object | null;
  snapshot(ref: object): GlobalGuardIdentity;
  rename(sourceParent: object, sourceName: string, source: object, targetParent: object, targetName: string): void;
  close(ref: object): void;
};
export type GlobalGuardEntry = Readonly<{ identity: GlobalGuardIdentity }>;
type Directory = { ref: object; initial: GlobalGuardIdentity; parent?: Directory; name?: string };
type Entry = { ref: object; directory: Directory; name: string; expected: GlobalGuardIdentity };
const leaf = (name: string) => assert.ok(typeof name === 'string' && name.length > 0 && name.length <= 255
  && !['.', '..'].includes(name) && !/[\\/\x00-\x1f:]/.test(name), 'global_guard_simple_name_required');
const directoryBinding = ({ dev, ino, kind, owner, group, mode, securitySha256 }: GlobalGuardIdentity) => ({ dev, ino, kind, owner, group, mode, securitySha256 });
const renamedBinding = ({ ctime: _, ...value }: GlobalGuardIdentity) => value;

/** Holds native ancestors/objects until explicit close. It never repairs permissions or overwrites a destination. */
export async function openGlobalPathGuard(paths: string[]) {
  assert.ok(paths.length > 0 && paths.length <= 32 && paths.every(path => isAbsolute(path) && !/[\x00-\x1f]/.test(path)), 'global_guard_absolute_directories_required');
  const spec = globalFilesystemNativeSpec();
  const driver: NativeGuardDriver = spec.windows ? await createWindowsGlobalGuard() : await createPosixGlobalGuard(spec);
  return bindGlobalPathGuard(paths, driver);
}

/** Driver injection is internal to native fixtures, never exposed by CLI options. */
export function bindGlobalPathGuard(paths: string[], driver: NativeGuardDriver) {
  const opened: object[] = [], directories = new Map<string, Directory>(), entries = new WeakMap<GlobalGuardEntry, Entry>();
  const aliases = new Map<string, string>(); let closed = false;
  const keep = (ref: object) => { opened.push(ref); return ref; };
  const close = () => {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    for (const ref of opened.reverse()) try { driver.close(ref); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'global_guard_close_unconfirmed');
  };
  const active = () => assert.ok(!closed, 'global_guard_closed');
  const inspect = (parent: object, name: string, purpose: 'parent' | 'observe' = 'observe') => {
    const ref = driver.openChild(parent, name, purpose); if (!ref) return null;
    try { return driver.snapshot(ref); } finally { driver.close(ref); }
  };
  const checkDirectories = () => {
    active();
    for (const [alias, canonical] of aliases) assert.equal(realpathSync(alias), canonical, 'global_guard_alias_changed');
    for (const directory of directories.values()) {
      assert.deepEqual(directoryBinding(driver.snapshot(directory.ref)), directoryBinding(directory.initial), 'global_guard_parent_changed');
      if (directory.parent) assert.deepEqual(directoryBinding(inspect(directory.parent.ref, directory.name!, 'parent')!), directoryBinding(directory.initial), 'global_guard_parent_name_changed');
    }
  };
  try {
    for (const path of paths) {
      const canonical = realpathSync(path); aliases.set(path, canonical);
      const root = parse(canonical).root;
      let current = directories.get(root);
      if (!current) {
        const ref = keep(driver.openRoot(root)); current = { ref, initial: driver.snapshot(ref) };
        assert.equal(current.initial.kind, 'directory'); directories.set(root, current);
      }
      let key = root;
      for (const name of relative(root, canonical).split(sep).filter(Boolean)) {
        leaf(name); key += (key.endsWith(sep) ? '' : sep) + name;
        let next = directories.get(key);
        if (!next) {
          const ref = driver.openChild(current.ref, name, 'parent'); assert.ok(ref, 'global_guard_parent_missing'); keep(ref);
          next = { ref, initial: driver.snapshot(ref), parent: current, name };
          assert.equal(next.initial.kind, 'directory', 'global_guard_parent_redirect'); directories.set(key, next);
        }
        current = next;
      }
    }
    checkDirectories();
  } catch (error) {
    try { close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'global_guard_open_and_close_failed'); }
    throw error;
  }
  const directory = (path: string) => {
    const canonical = aliases.get(path); assert.ok(canonical, 'global_guard_directory_outside_scope'); return directories.get(canonical)!;
  };
  return {
    close,
    assertCurrent: checkDirectories,
    retain(path: string, name: string): GlobalGuardEntry {
      leaf(name); checkDirectories(); const parent = directory(path);
      const ref = driver.openChild(parent.ref, name, 'mutation'); assert.ok(ref, 'global_guard_leaf_missing'); keep(ref);
      const expected = driver.snapshot(ref); assert.ok(expected.kind === 'directory' || expected.links === '1', 'global_guard_shared_leaf');
      assert.deepEqual(inspect(parent.ref, name), expected, 'global_guard_leaf_changed');
      const token = Object.freeze({ identity: Object.freeze({ ...expected }) }); entries.set(token, { ref, directory: parent, name, expected });
      return token;
    },
    moveNoReplace(token: GlobalGuardEntry, path: string, name: string) {
      leaf(name); checkDirectories(); const entry = entries.get(token); assert.ok(entry, 'global_guard_foreign_entry');
      const target = directory(path);
      assert.deepEqual(driver.snapshot(entry.ref), entry.expected, 'global_guard_leaf_changed');
      assert.deepEqual(inspect(entry.directory.ref, entry.name), entry.expected, 'global_guard_leaf_name_changed');
      assert.equal(inspect(target.ref, name), null, 'global_guard_destination_exists');
      const before = structuredClone(entry.expected);
      let issued = false;
      try {
        issued = true; driver.rename(entry.directory.ref, entry.name, entry.ref, target.ref, name);
        const after = driver.snapshot(entry.ref);
        assert.deepEqual(renamedBinding(after), renamedBinding(before), 'global_guard_renamed_object_changed');
        assert.deepEqual(inspect(target.ref, name), after, 'global_guard_destination_unbound');
        assert.equal(inspect(entry.directory.ref, entry.name), null, 'global_guard_source_reappeared');
        checkDirectories();
        entry.directory = target; entry.name = name; entry.expected = after;
        return { status: 'moved' as const, renameIssued: true as const, before, after, automaticRecovery: false as const };
      } catch (error) {
        // A syscall may have completed before a later identity/readback failure. Never infer rollback safety.
        const observe = (read: () => GlobalGuardIdentity | null) => {
          try { const value = read(); return value ? { state: 'present' as const, identity: value } : { state: 'absent' as const }; }
          catch { return { state: 'unknown' as const }; }
        };
        return { status: 'unknown' as const, renameIssued: issued, before,
          observations: { held: observe(() => driver.snapshot(entry.ref)), source: observe(() => inspect(entry.directory.ref, entry.name)), destination: observe(() => inspect(target.ref, name)) },
          reason: 'global_guard_move_unconfirmed',
          errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'), automaticRecovery: false as const };
      }
    },
  };
}
