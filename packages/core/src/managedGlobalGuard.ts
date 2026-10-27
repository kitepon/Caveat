import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, sep } from 'node:path';
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
  assertPrivateDirectory(ref: object): void;
  createWorking(parent: object, name: string, kind: GlobalGuardIdentity['kind'], linkTarget?: string): object;
  copyWorkingFile(source: object, target: object): void;
  finishWorking(ref: object, executable: boolean): void;
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
  const retired = new WeakSet<object>(), copiedTrees = new WeakSet<GlobalGuardTree>();
  const opened: object[] = [], directories = new Map<string, Directory>(), entries = new WeakMap<GlobalGuardEntry, Entry>();
  const trees = new WeakMap<GlobalGuardTree, { entry: GlobalGuardEntry; rows: GlobalGuardTreeRow[] }>();
  const journals = new WeakMap<GlobalGuardJournal, Entry & { bytes: Buffer; failed: boolean }>();
  const aliases = new Map<string, string>(); let closed = false;
  const keep = (ref: object) => { opened.push(ref); return ref; };
  const close = () => {
    if (closed) return; closed = true;
    const errors: unknown[] = [];
    for (const ref of opened.reverse()) try { if (!retired.has(ref)) driver.close(ref); } catch (error) { errors.push(error); }
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
    moveJournalNoReplace(token: GlobalGuardJournal, path: string, name: string) {
      guard.readJournal(token); const journal = journals.get(token)!;
      const entry = Object.freeze({ identity: Object.freeze({ ...journal.expected }) }); entries.set(entry, journal);
      const result = guard.moveNoReplace(entry, path, name); if (result.status !== 'moved') journal.failed = true; return result;
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
    createPrivateDirectory(path: string, name: string) {
      leaf(name); checkDirectories(); const parent = directory(path); driver.assertPrivateDirectory(parent.ref);
      assert.equal(inspect(parent.ref, name), null, 'global_guard_private_directory_exists');
      const ref = keep(driver.createWorking(parent.ref, name, 'directory')), initial = driver.snapshot(ref);
      driver.assertPrivateDirectory(ref); driver.finishWorking(ref, true);
      assert.deepEqual(inspect(parent.ref, name), driver.snapshot(ref), 'global_guard_private_directory_changed');
      assert.deepEqual(directoryBinding(driver.snapshot(ref)), directoryBinding(initial), 'global_guard_private_directory_changed');
      const canonical = join(aliases.get(path)!, name);
      directories.set(canonical, { ref, initial, parent, name }); aliases.set(canonical, canonical); checkDirectories(); return canonical;
    },
    assertPrivateDirectory(path: string) { checkDirectories(); driver.assertPrivateDirectory(directory(path).ref); },
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
    copyTreeNoReplace(token: GlobalGuardTree, path: string, name: string, stagingPath: string, stagingName: string) {
      leaf(name); leaf(stagingName); guard.readTree(token);
      const tree = trees.get(token)!, source = entries.get(tree.entry)!, target = directory(path), stage = directory(stagingPath);
      driver.assertPrivateDirectory(stage.ref);
      assert.equal(stage.initial.dev, source.expected.dev, 'global_working_cross_volume');
      assert.equal(target.initial.dev, source.expected.dev, 'global_working_cross_volume');
      assert.equal(inspect(target.ref, name), null, 'global_working_destination_exists');
      assert.equal(inspect(stage.ref, stagingName), null, 'global_working_stage_exists');
      assert.ok(target !== stage || name !== stagingName, 'global_working_distinct_stage_required');
      const originals = structuredClone(tree.rows), expected = new Map(originals.map(row => [row.relativePath, row.identity]));
      const children = new Map<string, string[]>();
      for (const row of originals) if (row.relativePath) {
        const split = row.relativePath.lastIndexOf('/'), parent = row.relativePath.slice(0, split < 0 ? 0 : split);
        const names = children.get(parent) ?? []; names.push(row.relativePath.slice(split + 1)); children.set(parent, names);
      }
      const created: { ref: object; parent: object; name: string; relativePath: string; binding: ReturnType<typeof directoryBinding> | null }[] = [];
      const evidence: { relativePath: string; identity: GlobalGuardIdentity }[] = [], cleanupErrors: string[] = [];
      let publication: unknown = null;
      const release = () => {
        for (const value of created.splice(0).reverse()) try { driver.close(value.ref); }
        catch (error) { cleanupErrors.push(createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex')); }
      };
      let phase = 'stage-create', currentPath = '';
      const copy = (input: object, parent: object, leafName: string, relativePath: string, ancestors: typeof created) => {
        checkDirectories();
        for (const held of ancestors) {
          assert.deepEqual(directoryBinding(driver.snapshot(held.ref)), held.binding, 'global_working_parent_changed');
          assert.deepEqual(inspect(held.parent, held.name), driver.snapshot(held.ref), 'global_working_parent_name_changed');
        }
        const before = driver.snapshot(input); assert.deepEqual(before, expected.get(relativePath), 'global_working_original_changed');
        phase = 'object-create'; currentPath = relativePath;
        const ref = driver.createWorking(parent, leafName, before.kind, before.linkTarget);
        const entry: typeof created[number] = { ref, parent, name: leafName, relativePath, binding: null }; created.push(entry);
        const initial = driver.snapshot(ref); entry.binding = directoryBinding(initial);
        assert.deepEqual(inspect(parent, leafName), initial, 'global_working_new_name_changed');
        assert.equal(initial.kind, before.kind, 'global_working_kind_changed');
        assert.ok(initial.dev === before.dev && initial.ino !== before.ino, 'global_working_original_reused');
        phase = 'file-copy';
        if (before.kind === 'file') driver.copyWorkingFile(input, ref);
        else if (before.kind === 'directory') {
          const names = driver.listDirectory(input).sort();
          assert.deepEqual(names, (children.get(relativePath) ?? []).sort(), 'global_working_original_names_changed');
          for (const childName of names) {
            leaf(childName); const child = driver.openChild(input, childName, 'mutation'); assert.ok(child, 'global_working_original_missing');
            try { copy(child, ref, childName, relativePath ? relativePath + '/' + childName : childName, [...ancestors, entry]); }
            finally { driver.close(child); }
          }
        }
        phase = 'object-flush'; currentPath = relativePath; driver.finishWorking(ref, (before.mode & 0o100) !== 0);
        const after = driver.snapshot(ref);
        assert.equal(after.contentSha256, before.contentSha256, 'global_working_content_changed');
        assert.equal(after.linkTarget, before.linkTarget, 'global_working_link_changed');
        assert.deepEqual(inspect(parent, leafName), after, 'global_working_new_name_changed');
        assert.deepEqual(driver.snapshot(input), before, 'global_working_original_changed');
        evidence.push({ relativePath, identity: after });
      };
      try {
        copy(source.ref, stage.ref, stagingName, '', []); guard.readTree(token);
        release(); assert.equal(cleanupErrors.length, 0, 'global_working_close_unconfirmed'); checkDirectories();
        phase = 'stage-readback';
        const working = guard.retainTree(stagingPath, stagingName), rows = guard.readTree(working);
        assert.equal(rows.length, originals.length, 'global_working_tree_changed');
        const createdByPath = new Map(evidence.map(row => [row.relativePath, row.identity]));
        // Windows may finalize new write timestamps on close; identity, bytes and security must still match creation.
        const createdBinding = ({ ctime: _, mtime: __, ...value }: GlobalGuardIdentity) => value;
        for (const row of rows) {
          assert.deepEqual(createdBinding(row.identity), createdBinding(createdByPath.get(row.relativePath)!), 'global_working_created_identity_changed');
          const original = expected.get(row.relativePath)!;
          assert.ok(original && row.identity.kind === original.kind && row.identity.contentSha256 === original.contentSha256
            && row.identity.linkTarget === original.linkTarget && row.identity.ino !== original.ino, 'global_working_tree_changed');
        }
        phase = 'publish-copy';
        const moved = guard.moveTreeNoReplace(working, path, name); publication = moved; guard.readTree(token);
        if (moved.status !== 'moved') return { status: 'unknown' as const, stagingName, created: evidence, move: moved, automaticRecovery: false as const };
        copiedTrees.add(working);
        return { status: 'copied' as const, stagingName, tree: working, rows: guard.readTree(working), originalSha256: createHash('sha256').update(JSON.stringify(originals)).digest('hex'), automaticRecovery: false as const };
      } catch (error) {
        const observations = created.map(value => {
          try { return { relativePath: value.relativePath, state: 'present' as const, identity: driver.snapshot(value.ref), named: inspect(value.parent, value.name) }; }
          catch { return { relativePath: value.relativePath, state: 'unknown' as const }; }
        });
        const observe = (read: () => GlobalGuardIdentity | null) => {
          try { const identity = read(); return identity ? { state: 'present' as const, identity } : { state: 'absent' as const }; }
          catch { return { state: 'unknown' as const }; }
        };
        const code = error instanceof Error ? (error as Error & { nativeCode?: number }).nativeCode : undefined;
        return { status: 'unknown' as const, stagingName, phase, relativePath: currentPath, nativeCode: Number.isSafeInteger(code) && code! >= 0 && code! <= 0xffffffff ? code! : null, created: evidence, observations, publication, cleanupErrors,
          placements: { stage: observe(() => inspect(stage.ref, stagingName)), destination: observe(() => inspect(target.ref, name)), original: observe(() => driver.snapshot(source.ref)) },
          errorSha256: createHash('sha256').update(error instanceof Error ? error.name + ':' + error.message : String(error)).digest('hex'), automaticRecovery: false as const };
      } finally { release(); }
    },
    releaseWorkingTree(token: GlobalGuardTree) {
      active(); assert.ok(copiedTrees.has(token), 'global_working_created_tree_required'); guard.readTree(token);
      const tree = trees.get(token)!, entry = entries.get(tree.entry)!; copiedTrees.delete(token); trees.delete(token); entries.delete(tree.entry);
      retired.add(entry.ref); driver.close(entry.ref);
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
