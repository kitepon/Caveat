import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindGlobalPathGuard, openGlobalPathGuard, type NativeGuardDriver } from '../src/managedGlobalGuard.js';
import { createGlobalMutationJournal } from '../src/managedGlobalJournal.js';
import { prepareGlobalObjectPreservation, type GlobalPreservationObject } from '../src/managedGlobalPreservation.js';
import { globalFilesystemNativeSpec, isWindows } from '../src/platform.js';
import { createPosixGlobalGuard } from '../src/managedPosixGuard.js';
import { createWindowsGlobalGuard } from '../src/managedWindowsGuard.js';
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
