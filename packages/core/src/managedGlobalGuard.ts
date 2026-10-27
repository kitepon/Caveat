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
  owner: string; group: string; mode: number; securitySha256?: string; contentSha256?: string; linkTarget?: string;
};
export type NativeGuardDriver = {
  openRoot(path: string): object;
  openChild(parent: object, name: string, purpose: 'parent' | 'observe-parent' | 'observe' | 'mutation' | 'journal-read'): object | null;
  snapshot(ref: object): GlobalGuardIdentity;
  listDirectory(ref: object): string[];
  createJournal(parent: object, name: string): object;
  appendJournal(ref: object, bytes: Buffer): void;
  flushJournal(ref: object): void;
  readJournal(ref: object): Buffer;
  rename(sourceParent: object, sourceName: string, source: object, targetParent: object, targetName: string): void;
  close(ref: object): void;
};
export type GlobalGuardEntry = Readonly<{ identity: GlobalGuardIdentity }>;
export type GlobalGuardTreeRow = { relativePath: string; identity: GlobalGuardIdentity };
export type GlobalGuardTree = Readonly<{ tree: true; sha256: string }>;
export type GlobalGuardJournal = Readonly<{ journal: true }>;
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
  const trees = new WeakMap<GlobalGuardTree, { entry: GlobalGuardEntry; rows: GlobalGuardTreeRow[] }>();
  const journals = new WeakMap<GlobalGuardJournal, Entry & { bytes: Buffer; failed: boolean }>();
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
    const ref = driver.openChild(parent, name, purpose === 'parent' ? 'observe-parent' : 'observe'); if (!ref) return null;
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
      const canonical = realpathSync(path); aliases.set(path, canonical); aliases.set(canonical, canonical);
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
  const treeInventory = (ref: object, volume: string) => {
    const rows: GlobalGuardTreeRow[] = []; let bytes = 0;
    const visit = (held: object, relativePath: string, depth: number) => {
      assert.ok(rows.length < 100000 && depth <= 128, 'global_guard_tree_entry_or_depth_bound');
      const before = driver.snapshot(held);
      assert.equal(before.dev, volume, 'global_guard_tree_cross_volume');
      assert.ok(before.kind === 'directory' || before.links === '1', 'global_guard_tree_shared_leaf');
      if (before.kind === 'file') { bytes += Number(before.size); assert.ok(bytes <= 128 * 1024 * 1024, 'global_guard_tree_byte_bound'); }
      rows.push({ relativePath, identity: before });
      if (before.kind === 'directory') {
        const names = driver.listDirectory(held).sort();
        assert.ok(names.length <= 100000 && new Set(names).size === names.length, 'global_guard_tree_duplicate_or_bound');
        for (const name of names) {
          leaf(name); const child = driver.openChild(held, name, 'mutation'); assert.ok(child, 'global_guard_tree_child_missing');
          try {
            visit(child, relativePath ? relativePath + '/' + name : name, depth + 1);
            assert.deepEqual(inspect(held, name), driver.snapshot(child), 'global_guard_tree_child_name_changed');
          } finally { driver.close(child); }
        }
        assert.deepEqual(driver.listDirectory(held).sort(), names, 'global_guard_tree_names_changed');
      }
      assert.deepEqual(driver.snapshot(held), before, 'global_guard_tree_changed');
    };
    visit(ref, '', 0); return rows;
  };
  const guard = {
    close,
    assertCurrent: checkDirectories,
    createJournal(path: string, name: string, header: Buffer): GlobalGuardJournal {
      leaf(name); checkDirectories(); assert.ok(Buffer.isBuffer(header) && header.length > 0 && header.length <= 65536, 'global_journal_record_bound');
      const parent = directory(path), bytes = Buffer.from(header), ref = keep(driver.createJournal(parent.ref, name));
      driver.appendJournal(ref, bytes); driver.flushJournal(ref);
      const expected = driver.snapshot(ref);
      assert.ok(expected.kind === 'file' && expected.links === '1', 'global_journal_invalid_created_file');
      assert.deepEqual(driver.readJournal(ref), bytes, 'global_journal_readback_changed');
      assert.deepEqual(inspect(parent.ref, name), expected, 'global_journal_name_changed'); checkDirectories();
      const token = Object.freeze({ journal: true as const }); journals.set(token, { ref, directory: parent, name, expected, bytes, failed: false }); return token;
    },
    appendJournal(token: GlobalGuardJournal, record: Buffer) {
      active(); const journal = journals.get(token); assert.ok(journal && !journal.failed, 'global_journal_unknown_or_failed_token');
      assert.ok(Buffer.isBuffer(record) && record.length > 0 && record.length <= 65536 && journal.bytes.length + record.length <= 16 * 1024 * 1024, 'global_journal_record_bound');
      checkDirectories(); assert.deepEqual(driver.snapshot(journal.ref), journal.expected, 'global_journal_changed');
      assert.deepEqual(inspect(journal.directory.ref, journal.name), journal.expected, 'global_journal_name_changed');
      const bytes = Buffer.concat([journal.bytes, Buffer.from(record)]);
      journal.failed = true;
      driver.appendJournal(journal.ref, bytes.subarray(journal.bytes.length)); driver.flushJournal(journal.ref);
      const after = driver.snapshot(journal.ref);
      assert.deepEqual(directoryBinding(after), directoryBinding(journal.expected), 'global_journal_identity_changed');
      assert.equal(after.links, '1', 'global_journal_shared_file');
      assert.deepEqual(driver.readJournal(journal.ref), bytes, 'global_journal_readback_changed');
      assert.deepEqual(inspect(journal.directory.ref, journal.name), after, 'global_journal_name_changed'); checkDirectories();
      journal.bytes = bytes; journal.expected = after; journal.failed = false;
      return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    readJournal(token: GlobalGuardJournal) {
      active(); const journal = journals.get(token); assert.ok(journal && !journal.failed, 'global_journal_unknown_or_failed_token');
      checkDirectories(); assert.deepEqual(driver.snapshot(journal.ref), journal.expected, 'global_journal_changed');
      assert.deepEqual(inspect(journal.directory.ref, journal.name), journal.expected, 'global_journal_name_changed');
      const bytes = driver.readJournal(journal.ref); assert.deepEqual(bytes, journal.bytes, 'global_journal_readback_changed'); return bytes;
    },
    readPersistedJournal(path: string, name: string) {
      leaf(name); checkDirectories(); const parent = directory(path), ref = driver.openChild(parent.ref, name, 'journal-read');
      assert.ok(ref, 'global_journal_missing');
      try {
        const bytes = driver.readJournal(ref), before = driver.snapshot(ref);
        assert.ok(before.kind === 'file' && before.links === '1' && before.contentSha256 === createHash('sha256').update(bytes).digest('hex'), 'global_journal_changed');
        assert.deepEqual(inspect(parent.ref, name), before, 'global_journal_name_changed');
        assert.deepEqual(driver.snapshot(ref), before, 'global_journal_changed'); checkDirectories(); return bytes;
      } finally { driver.close(ref); }
    },
    directoryIdentity(path: string) { checkDirectories(); return driver.snapshot(directory(path).ref); },
    canonicalDirectory(path: string) { checkDirectories(); directory(path); return aliases.get(path)!; },
    observe(path: string, name: string) { leaf(name); checkDirectories(); const parent = directory(path); return inspect(parent.ref, name); },
    retainTree(path: string, name: string): GlobalGuardTree {
      const entry = guard.retain(path, name), held = entries.get(entry)!;
      const rows = treeInventory(held.ref, held.expected.dev);
      assert.deepEqual(rows[0]!.identity, held.expected, 'global_guard_tree_changed'); checkDirectories();
      const token = Object.freeze({ tree: true as const, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') });
      trees.set(token, { entry, rows }); guard.readTree(token); return token;
    },
    readTree(token: GlobalGuardTree): GlobalGuardTreeRow[] {
      active(); const tree = trees.get(token); assert.ok(tree, 'global_guard_foreign_tree'); checkDirectories();
      const entry = entries.get(tree.entry)!;
      assert.deepEqual(inspect(entry.directory.ref, entry.name), entry.expected, 'global_guard_tree_root_name_changed');
      const rows = treeInventory(entry.ref, entry.expected.dev);
      assert.deepEqual(rows, tree.rows, 'global_guard_tree_changed'); checkDirectories(); return structuredClone(rows);
    },
    moveTreeNoReplace(token: GlobalGuardTree, path: string, name: string) {
      const tree = trees.get(token); assert.ok(tree, 'global_guard_foreign_tree');
      guard.readTree(token); const before = structuredClone(tree.rows);
      const result = guard.moveNoReplace(tree.entry, path, name);
      if (result.status !== 'moved') return { ...result, treeBefore: before };
      let observed: GlobalGuardTreeRow[] | null = null;
      try {
        const entry = entries.get(tree.entry)!, rows = treeInventory(entry.ref, entry.expected.dev); observed = rows;
        const expected = structuredClone(before); expected[0]!.identity = result.after;
        assert.deepEqual(rows, expected, 'global_guard_tree_changed_after_move');
        tree.rows = rows; guard.readTree(token);
        return { ...result, treeBefore: before, treeAfter: structuredClone(rows) };
      } catch (error) {
        return { status: 'unknown' as const, renameIssued: true as const, reason: 'global_guard_tree_move_unconfirmed', treeBefore: before,
          rootMove: result, treeObserved: observed, errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'), automaticRecovery: false as const };
      }
    },
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
      let issued = false, phase = 'native-rename';
      try {
        issued = true; driver.rename(entry.directory.ref, entry.name, entry.ref, target.ref, name);
        phase = 'held-readback';
        const after = driver.snapshot(entry.ref);
        assert.deepEqual(renamedBinding(after), renamedBinding(before), 'global_guard_renamed_object_changed');
        phase = 'destination-readback';
        assert.deepEqual(inspect(target.ref, name), after, 'global_guard_destination_unbound');
        phase = 'source-readback';
        assert.equal(inspect(entry.directory.ref, entry.name), null, 'global_guard_source_reappeared');
        phase = 'parent-readback';
        checkDirectories();
        entry.directory = target; entry.name = name; entry.expected = after;
        return { status: 'moved' as const, renameIssued: true as const, before, after, automaticRecovery: false as const };
      } catch (error) {
        // A syscall may have completed before a later identity/readback failure. Never infer rollback safety.
        const observe = (read: () => GlobalGuardIdentity | null) => {
          try { const value = read(); return value ? { state: 'present' as const, identity: value } : { state: 'absent' as const }; }
          catch { return { state: 'unknown' as const }; }
        };
        const nativeCode = error instanceof Error ? (error as Error & { nativeCode?: number }).nativeCode : undefined;
        return { status: 'unknown' as const, renameIssued: issued, before, phase,
          nativeCode: Number.isSafeInteger(nativeCode) && nativeCode! >= 0 && nativeCode! <= 0xffffffff ? nativeCode! : null,
          observations: { held: observe(() => driver.snapshot(entry.ref)), source: observe(() => inspect(entry.directory.ref, entry.name)), destination: observe(() => inspect(target.ref, name)) },
          reason: 'global_guard_move_unconfirmed',
          errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'), automaticRecovery: false as const };
      }
    },
  };
  return guard;
}
