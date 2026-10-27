import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, linkSync, statSync, readlinkSync, renameSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindGlobalPathGuard, openGlobalPathGuard, type NativeGuardDriver } from '../src/managedGlobalGuard.js';
import { createGlobalMutationJournal } from '../src/managedGlobalJournal.js';
import { prepareGlobalObjectPreservation, type GlobalPreservationObject } from '../src/managedGlobalPreservation.js';
import { globalFilesystemNativeSpec, isWindows } from '../src/platform.js';
import { createPosixGlobalGuard } from '../src/managedPosixGuard.js';
import { createWindowsGlobalGuard } from '../src/managedWindowsGuard.js';
import { runOwnedGlobalNpm } from '../src/managedGlobalNpm.js';
import { runWindowsAclPrivateTree } from '../src/privateWindowsAcl.js';
const roots: string[] = [], plan = 'c'.repeat(64);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-original-tree-'))); roots.push(root);
  const source = join(root, 'global'), backup = join(root, 'backup'), pkg = join(source, 'caveat-cli');
  mkdirSync(join(pkg, 'node_modules', 'dep'), { recursive: true, mode: 0o700 }); mkdirSync(backup, { mode: 0o700 });
  for (const [path, bytes] of [['package.json', '{"name":"caveat-cli","version":"fixture"}'], ['node_modules/dep/index.js', 'original dependency bytes']]) writeFileSync(join(pkg, path!), bytes!, { mode: 0o600 });
  writeFileSync(join(source, '.package-lock.json'), 'original npm management', { mode: 0o600 });
  writeFileSync(join(source, 'caveat'), 'old wrapper', { mode: 0o700 });
  if (isWindows()) runWindowsAclPrivateTree(root);
  const objects: GlobalPreservationObject[] = [
    { step: 'package', role: 'package', directory: source, name: 'caveat-cli', backupDirectory: backup, backupName: 'original-package' },
    { step: 'management', role: 'npm-management', directory: source, name: '.package-lock.json', backupDirectory: backup, backupName: 'original-management' },
    { step: 'leaf', role: 'leaf', directory: source, name: 'caveat', backupDirectory: backup, backupName: 'original-leaf' },
  ];
  return { root, source, backup, pkg, objects };
}
async function native(): Promise<NativeGuardDriver> { const spec = globalFilesystemNativeSpec(); return spec.windows ? createWindowsGlobalGuard() : createPosixGlobalGuard(spec); }
describe('held original trees and known-only preservation', () => {
  it('rejects a reviewed token for another object before writing original evidence', async () => {
    const { source, backup, objects } = fixture();
    cpSync(join(source, 'caveat-cli'), join(source, 'other-original'), { recursive: true });
    if (isWindows()) runWindowsAclPrivateTree(source);
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const wrong = guard.retainTree(source, 'other-original'), journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan);
      expect(() => prepareGlobalObjectPreservation(guard, journal, objects, async () => {}, new Map([['package', wrong]]))).toThrow('reviewed_name_changed');
      expect(journal.read().records).toHaveLength(0);
      expect(existsSync(join(source, 'caveat-cli'))).toBe(true);
    } finally { guard.close(); }
  });
  it('uses the same reviewed native pins for preservation without opening conflicting mutation handles', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const reviewed = new Map(objects.map(item => [item.step, guard.retainTree(item.directory, item.name)]));
      const before = objects.map(item => guard.readTree(reviewed.get(item.step)!));
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan);
      const engine = prepareGlobalObjectPreservation({ ...guard, retainTree() { throw Error('duplicate native pin'); } }, journal, objects, async () => {}, reviewed);
      expect(engine.manifest().objects.map(row => row.rows)).toEqual(before);
      expect((await engine.preserveAll()).status).toBe('preserved');
      for (const item of objects) expect((await engine.restoreKnown(item.step)).status).toBe('confirmed');
    } finally { guard.close(); }
  });
  it('retains every original object with durable ordered evidence and restores the known tree without reconstruction', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]); let checks = 0;
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan);
      const engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => { checks++; });
      const before = engine.manifest(), originalEvidence = readFileSync(join(backup, before.originalEvidence.name));
      expect(JSON.parse(originalEvidence.toString()).objects[0].rows).toEqual(before.objects[0]!.rows);
      const result = await engine.preserveAll();
      expect(result.status).toBe('preserved'); expect(checks).toBe(3); expect(journal.read().records).toHaveLength(6);
      for (let index = 0; index < objects.length; index++) {
        expect(existsSync(join(source, objects[index]!.name))).toBe(false);
        expect(result.manifest.objects[index]!.rows.map(row => [row.relativePath, row.identity.dev, row.identity.ino, row.identity.securitySha256, row.identity.contentSha256]))
          .toEqual(before.objects[index]!.rows.map(row => [row.relativePath, row.identity.dev, row.identity.ino, row.identity.securitySha256, row.identity.contentSha256]));
      }
      await expect(engine.restoreKnown('leaf')).rejects.toThrow('package_restore_required');
      expect((await engine.restoreKnown('package')).status).toBe('confirmed');
      await expect(engine.restoreKnown('leaf')).rejects.toThrow('management_restore_required');
      expect(readFileSync(join(source, 'caveat-cli/node_modules/dep/index.js'), 'utf8')).toBe('original dependency bytes');
      const final = journal.read(), last = final.records.at(-1)!;
      const evidence = readFileSync(join(backup, 'state-' + final.header.runId + '-' + last.sequence + '.json'));
      expect(JSON.parse(evidence.toString()).manifest.objects[0].state).toBe('restored');
      expect(engine.manifest().objects[0]!.state).toBe('restored'); expect(journal.read().status).toBe('ready');
    } finally { guard.close(); }
  });
  it('stops before intent or original mutation for an unknown process/writer from the mandatory caller check', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan);
      const engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => { throw Error('unknown writer'); });
      expect((await engine.preserveAll()).status).toBe('stopped'); expect(journal.read().records).toHaveLength(0);
      expect(existsSync(join(source, 'caveat-cli'))).toBe(true); expect(engine.manifest().objects.every(row => row.state === 'original')).toBe(true);
    } finally { guard.close(); }
  });
  it('detects a deep content change even when no directory child is added or removed', async () => {
    const { source, backup, pkg, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      writeFileSync(join(pkg, 'node_modules/dep/index.js'), 'changed dependency');
      expect((await engine.preserveAll()).status).toBe('stopped'); expect(journal.read().records).toHaveLength(0); expect(existsSync(pkg)).toBe(true);
    } finally { guard.close(); }
  });
  it('records a completed first retain and unknown second intent without replaying or silently rolling back', async () => {
    const { source, backup, objects } = fixture(), driver = await native(); let calls = 0;
    const guard = bindGlobalPathGuard([source, backup], { ...driver, rename(...args) { if (++calls === 2) throw Error('injected management move failure'); driver.rename(...args); } });
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      const result = await engine.preserveAll(); expect(result.status).toBe('unknown'); expect(calls).toBe(2);
      expect(engine.manifest().objects.map(row => row.state)).toEqual(['preserved', 'unknown', 'original']);
      expect(journal.read().status).toBe('unknown'); expect(existsSync(join(backup, 'original-package'))).toBe(true);
      await expect(engine.restoreKnown('package')).rejects.toThrow('not_known'); expect(calls).toBe(2);
    } finally { guard.close(); }
  });
  it('never overwrites a destination introduced before recovery and retains the original package', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); writeFileSync(join(source, 'caveat-cli'), 'new unknown object', { mode: 0o600 });
      expect((await engine.restoreKnown('package')).status).toBe('unknown');
      expect(readFileSync(join(source, 'caveat-cli'), 'utf8')).toBe('new unknown object'); expect(existsSync(join(backup, 'original-package/node_modules/dep/index.js'))).toBe(true);
    } finally { guard.close(); }
  });
  it('treats a deep change after the native move as unknown instead of claiming full-tree preservation', async () => {
    const { source, backup } = fixture(), driver = await native();
    const guard = bindGlobalPathGuard([source, backup], { ...driver, rename(...args) { driver.rename(...args); writeFileSync(join(backup, 'saved/node_modules/dep/index.js'), 'raced bytes'); } });
    try {
      const tree = guard.retainTree(source, 'caveat-cli'), result = guard.moveTreeNoReplace(tree, backup, 'saved');
      expect(result.status).toBe('unknown'); expect(existsSync(join(backup, 'saved'))).toBe(true); expect(existsSync(join(source, 'caveat-cli'))).toBe(false);
    } finally { guard.close(); }
  });
  it('refuses shared descendants and duplicate native names without a rename', async () => {
    const { source, backup, pkg } = fixture(); linkSync(join(pkg, 'package.json'), join(pkg, 'shared'));
    const guard = await openGlobalPathGuard([source, backup]);
    try { expect(() => guard.retainTree(source, 'caveat-cli')).toThrow('shared_leaf'); } finally { guard.close(); }
    const driver = await native(), duplicate = bindGlobalPathGuard([source, backup], { ...driver, listDirectory() { return ['package.json', 'package.json']; } });
    try { expect(() => duplicate.retainTree(source, 'caveat-cli')).toThrow('duplicate_or_bound'); } finally { duplicate.close(); }
  });
  it.skipIf(isWindows())('retains internal symlink targets and refuses package links escaping the held tree', async () => {
    const { source, backup, pkg, objects } = fixture(); symlinkSync('node_modules/dep/index.js', join(pkg, 'entry'));
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const tree = guard.retainTree(source, 'caveat-cli'); expect(guard.readTree(tree).find(row => row.relativePath === 'entry')!.identity.linkTarget).toBe('node_modules/dep/index.js');
      symlinkSync('../../outside', join(pkg, 'escape'));
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan);
      expect(() => prepareGlobalObjectPreservation(guard, journal, objects, async () => {})).toThrow('external_package_link');
      expect(existsSync(pkg)).toBe(true); expect(journal.read().records).toHaveLength(0);
    } finally { guard.close(); }
  });
  it('leaves durable intent pending when the post-move state file cannot flush and never retries a mutation', async () => {
    const { source, backup, objects } = fixture(), driver = await native(), files = new WeakMap<object, string>(); let calls = 0;
    const guard = bindGlobalPathGuard([source, backup], { ...driver,
      createJournal(parent, name) { const ref = driver.createJournal(parent, name); files.set(ref, name); return ref; },
      flushJournal(ref) { if (files.get(ref)?.startsWith('state-')) throw Error('injected state flush failure'); driver.flushJournal(ref); },
      rename(...args) { calls++; driver.rename(...args); },
    });
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      const result = await engine.preserveAll(); expect(result.status).toBe('unknown'); expect(calls).toBe(1);
      expect(journal.read().status).toBe('pending'); expect(engine.manifest().objects.map(row => row.state)).toEqual(['preserved', 'original', 'original']);
      await expect(engine.preserveAll()).rejects.toThrow('not_fresh'); expect(calls).toBe(1);
    } finally { guard.close(); }
  });
  it.skipIf(isWindows())('binds versioned native symbols by name without feeding dollar signs to the C parser', async () => {
    const spec = globalFilesystemNativeSpec(); if (spec.windows) throw Error('fixture_platform_mismatch');
    await expect(createPosixGlobalGuard({ ...spec, directoryRead: 'caveat$missing_fixture_symbol' })).rejects.toThrow(/Cannot find function/);
  });
  it('rejects scope expansion to another global package before reading its contents', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan);
      expect(() => prepareGlobalObjectPreservation(guard, journal, [{ ...objects[0]!, name: 'other-global' }], async () => {})).toThrow('scope_invalid');
      expect(journal.read().records).toHaveLength(0);
    } finally { guard.close(); }
  });
});


describe('private working copies from retained originals', () => {
  it('copies content to new private inodes only after durable original evidence and keeps originals intact', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      const original = engine.manifest();
      await expect(engine.createWorkingCopies()).rejects.toThrow('not_ready_for_working_copy');
      expect((await engine.preserveAll()).status).toBe('preserved');
      expect(existsSync(join(backup, original.originalEvidence.name))).toBe(true);
      const result = await engine.createWorkingCopies(); expect(result.status, JSON.stringify(result)).toBe('working');
      for (const row of result.manifest.objects) {
        expect(row.state).toBe('preserved'); expect(row.working?.status).toBe('known');
        for (const copy of row.working!.rows!) {
          const before = row.rows.find(value => value.relativePath === copy.relativePath)!;
          expect(copy.identity.ino).not.toBe(before.identity.ino); expect(copy.identity.contentSha256).toBe(before.identity.contentSha256);
        }
      }
      expect(readFileSync(join(source, 'caveat-cli/node_modules/dep/index.js'), 'utf8')).toBe('original dependency bytes');
      expect(readFileSync(join(backup, 'original-package/node_modules/dep/index.js'), 'utf8')).toBe('original dependency bytes');
      expect(journal.read().records).toHaveLength(12);
      if (!isWindows()) { expect(statSync(join(source, 'caveat-cli/package.json')).mode & 0o777).toBe(0o600); expect(statSync(join(source, 'caveat')).mode & 0o777).toBe(0o700); }
    } finally { guard.close(); }
  });
  it('quarantines exact known working copies before restoring the original objects in dependency order', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      const original = engine.manifest(); expect((await engine.preserveAll()).status).toBe('preserved'); expect((await engine.createWorkingCopies()).status).toBe('working');
      await expect(engine.restoreKnown('package')).rejects.toThrow('working_copy_present');
      for (const row of objects) {
        expect((await engine.quarantineWorking(row.step)).status).toBe('confirmed');
        expect((await engine.restoreKnown(row.step)).status).toBe('confirmed');
      }
      for (let index = 0; index < objects.length; index++) expect(engine.manifest().objects[index]!.rows[0]!.identity.ino).toBe(original.objects[index]!.rows[0]!.identity.ino);
      expect(readFileSync(join(source, 'caveat'), 'utf8')).toBe('old wrapper'); expect(journal.read().status).toBe('ready');
    } finally { guard.close(); }
  });
  it('keeps an unknown destination unchanged instead of copying over it', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); writeFileSync(join(source, 'caveat-cli'), 'unknown destination', { mode: 0o600 });
      expect((await engine.createWorkingCopies()).status).toBe('unknown'); expect(journal.read().status).toBe('unknown');
      expect(readFileSync(join(source, 'caveat-cli'), 'utf8')).toBe('unknown destination'); expect(existsSync(join(backup, 'original-package'))).toBe(true);
    } finally { guard.close(); }
  });
  it('retains a failed staging copy and exact partial state without publishing, deleting or retrying', async () => {
    const { source, backup, objects } = fixture(), driver = await native(); let calls = 0;
    const guard = bindGlobalPathGuard([source, backup], { ...driver, copyWorkingFile(input, output) { calls++; driver.copyWorkingFile(input, output); throw Error('injected copy completion loss'); } });
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); const result = await engine.createWorkingCopies();
      expect(result.status).toBe('unknown'); expect(calls).toBe(1); expect(journal.read().status).toBe('unknown');
      expect(existsSync(join(source, 'caveat-cli'))).toBe(false); expect(existsSync(join(backup, result.manifest.objects[0]!.working!.stagingName))).toBe(true);
      expect(result.manifest.objects[0]!.state).toBe('preserved'); expect(result.manifest.objects[0]!.working!.status).toBe('unknown');
      await expect(engine.createWorkingCopies()).rejects.toThrow('not_ready_for_working_copy'); expect(calls).toBe(1);
    } finally { guard.close(); }
  });
  it('refuses to quarantine a working tree changed by an unknown writer', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); expect((await engine.createWorkingCopies()).status).toBe('working');
      const count = journal.read().records.length; writeFileSync(join(source, 'caveat-cli/node_modules/dep/index.js'), 'unknown new writer');
      expect((await engine.quarantineWorking('package')).status).toBe('stopped'); expect(journal.read().records).toHaveLength(count);
      expect(readFileSync(join(source, 'caveat-cli/node_modules/dep/index.js'), 'utf8')).toBe('unknown new writer');
      expect(readFileSync(join(backup, 'original-package/node_modules/dep/index.js'), 'utf8')).toBe('original dependency bytes');
    } finally { guard.close(); }
  });
  it('only permits native file writes, chmod and release through newly created working brands', async () => {
    const { source, backup } = fixture(), driver = await native(); let original: object | null = null, closedCopy: object | null = null;
    const guard = bindGlobalPathGuard([source, backup], { ...driver,
      openChild(parent, name, purpose) { const ref = driver.openChild(parent, name, purpose); if (name === 'package.json' && purpose === 'mutation') original = ref; return ref; },
      createWorking(...args) { const ref = driver.createWorking(...args); if (args[2] === 'file') closedCopy = ref; return ref; },
    });
    try {
      const tree = guard.retainTree(source, 'caveat-cli'); expect(original).not.toBeNull();
      expect(() => driver.copyWorkingFile(original!, original!)).toThrow('owned_creation_required'); expect(() => driver.finishWorking(original!, true)).toThrow('owned_creation_required');
      expect(() => guard.releaseWorkingTree(tree)).toThrow('created_tree_required');
      const result = guard.copyTreeNoReplace(tree, source, 'new-copy', backup, 'private-stage'); expect(result.status, JSON.stringify(result)).toBe('copied');
      if (result.status !== 'copied') throw Error('copy_unconfirmed');
      expect(() => driver.finishWorking(closedCopy!, true)).toThrow('owned_creation_required'); guard.releaseWorkingTree(result.tree);
      expect(() => guard.readTree(result.tree)).toThrow('foreign_tree'); expect(guard.readTree(tree)[0]!.identity.kind).toBe('directory');
    } finally { guard.close(); }
  });
  it('stops before publication if closing a newly created handle has an unconfirmed outcome', async () => {
    const { source, backup } = fixture(), driver = await native(), created = new WeakSet<object>(); let closes = 0;
    const guard = bindGlobalPathGuard([source, backup], { ...driver,
      createWorking(...args) { const ref = driver.createWorking(...args); created.add(ref); return ref; },
      close(ref) { driver.close(ref); if (created.has(ref) && ++closes === 1) throw Error('injected close outcome lost'); },
    });
    try {
      const tree = guard.retainTree(source, 'caveat-cli'), result = guard.copyTreeNoReplace(tree, source, 'new-copy', backup, 'private-stage');
      expect(result.status).toBe('unknown'); expect(existsSync(join(source, 'new-copy'))).toBe(false); expect(existsSync(join(backup, 'private-stage'))).toBe(true);
      if (result.status === 'unknown' && 'cleanupErrors' in result) { expect(result.cleanupErrors).toHaveLength(1); expect(result.placements.destination.state).toBe('absent'); }
      else throw Error('cleanup_receipt_missing');
      expect(guard.readTree(tree)[0]!.identity.kind).toBe('directory');
    } finally { guard.close(); }
  });
  it('rejects a substituted staging tree even when its content matches the created copy', async () => {
    const { source, backup } = fixture(), driver = await native(); let stageRoot: object | null = null;
    const guard = bindGlobalPathGuard([source, backup], { ...driver,
      createWorking(parent, name, kind, target) { const ref = driver.createWorking(parent, name, kind, target); if (name === 'private-stage') stageRoot = ref; return ref; },
      close(ref) {
        driver.close(ref);
        if (ref === stageRoot) { stageRoot = null; renameSync(join(backup, 'private-stage'), join(backup, 'created-stage')); cpSync(join(backup, 'created-stage'), join(backup, 'private-stage'), { recursive: true }); }
      },
    });
    try {
      const tree = guard.retainTree(source, 'caveat-cli'), result = guard.copyTreeNoReplace(tree, source, 'new-copy', backup, 'private-stage');
      expect(result.status).toBe('unknown'); expect(existsSync(join(source, 'new-copy'))).toBe(false);
      expect(existsSync(join(backup, 'created-stage'))).toBe(true); expect(existsSync(join(backup, 'private-stage'))).toBe(true);
    } finally { guard.close(); }
  });
  it.skipIf(isWindows())('copies relative internal symlink objects without following their targets', async () => {
    const { source, backup, pkg, objects } = fixture(); symlinkSync('node_modules/dep/index.js', join(pkg, 'entry'));
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); const result = await engine.createWorkingCopies(); expect(result.status, JSON.stringify(result)).toBe('working');
      expect(readlinkSync(join(source, 'caveat-cli/entry'))).toBe('node_modules/dep/index.js'); expect(readlinkSync(join(backup, 'original-package/entry'))).toBe('node_modules/dep/index.js');
      expect(readFileSync(join(source, 'caveat-cli/entry'), 'utf8')).toBe('original dependency bytes');
    } finally { guard.close(); }
  });
});


describe('working-copy evidence and original attributes', () => {
  it.skipIf(isWindows())('stops if the original evidence file changes before any original move', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      writeFileSync(join(backup, engine.manifest().originalEvidence.name), 'unknown evidence writer');
      expect((await engine.preserveAll()).status).toBe('stopped'); expect(journal.read().records).toHaveLength(0); expect(existsSync(join(source, 'caveat-cli'))).toBe(true);
    } finally { guard.close(); }
  });
  it.skipIf(!isWindows())('keeps the original descendant alternate stream through copying and exact recovery', async () => {
    const { source, backup, pkg, objects } = fixture(); writeFileSync(join(pkg, 'node_modules/dep/index.js') + ':original-stream', 'original alternate bytes');
    const guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); expect((await engine.createWorkingCopies()).status).toBe('working');
      expect(readFileSync(join(backup, 'original-package/node_modules/dep/index.js') + ':original-stream', 'utf8')).toBe('original alternate bytes');
      expect((await engine.quarantineWorking('package')).status).toBe('confirmed'); expect((await engine.restoreKnown('package')).status).toBe('confirmed');
      expect(readFileSync(join(source, 'caveat-cli/node_modules/dep/index.js') + ':original-stream', 'utf8')).toBe('original alternate bytes');
    } finally { guard.close(); }
  });
});


describe('known-only state after an owned child fails', () => {
  it('can quarantine a verified deletion-only partial tree and restore the original after nonzero close', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); expect((await engine.createWorkingCopies()).status).toBe('working');
      const code = 'require("node:fs").unlinkSync(' + JSON.stringify(join(source, 'caveat-cli/node_modules/dep/index.js')) + ');process.exit(7);';
      const result = await engine.uninstallWorking(() => runOwnedGlobalNpm(process.execPath, ['-e', code], source, {}, () => {}, 5000));
      expect(result.status).toBe('failed-known'); expect(result.receipt?.exitCode).toBe(7);
      expect((await engine.quarantineWorking('package')).status).toBe('confirmed'); expect((await engine.restoreKnown('package')).status).toBe('confirmed');
      expect(readFileSync(join(source, 'caveat-cli/node_modules/dep/index.js'), 'utf8')).toBe('original dependency bytes');
    } finally { guard.close(); }
  });
  it('retains unknown new files and their observed identities instead of deleting or restoring over them', async () => {
    const { source, backup, objects } = fixture(), guard = await openGlobalPathGuard([source, backup]);
    try {
      const journal = createGlobalMutationJournal(guard, backup, 'run.jsonl', plan), engine = prepareGlobalObjectPreservation(guard, journal, objects, async () => {});
      expect((await engine.preserveAll()).status).toBe('preserved'); expect((await engine.createWorkingCopies()).status).toBe('working');
      const file = join(source, 'caveat-cli/unexpected');
      const code = 'require("node:fs").writeFileSync(' + JSON.stringify(file) + ',"unknown bytes",{mode:0o600});process.exit(7);';
      const result = await engine.uninstallWorking(() => runOwnedGlobalNpm(process.execPath, ['-e', code], source, {}, () => {}, 5000));
      expect(result.status).toBe('unknown'); expect(journal.read().status).toBe('unknown');
      if ('after' in result) expect(result.after?.[0]?.rows?.some(row => row.relativePath === 'unexpected')).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('unknown bytes'); await expect(engine.quarantineWorking('package')).rejects.toThrow('no_known_working_copy');
      expect(readFileSync(join(backup, 'original-package/node_modules/dep/index.js'), 'utf8')).toBe('original dependency bytes');
    } finally { guard.close(); }
  });
});
