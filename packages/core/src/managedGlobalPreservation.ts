import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { openGlobalPathGuard } from './managedGlobalGuard.js';
import type { createGlobalMutationJournal } from './managedGlobalJournal.js';

type Guard = Awaited<ReturnType<typeof openGlobalPathGuard>>;
type Journal = ReturnType<typeof createGlobalMutationJournal>;
export type GlobalPreservationObject = {
  step: string; role: 'package' | 'npm-management' | 'leaf';
  directory: string; name: string; backupDirectory: string; backupName: string;
};
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (parent: string, child: string) => {
  const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
};
const errorSha = (error: unknown) => sha(error instanceof Error ? error.name + ':' + error.message : String(error));

/** Internal engine: the caller must bind fresh package/protected-state/process checks; no CLI bypass exists. */
export function prepareGlobalObjectPreservation(guard: Guard, journal: Journal, input: GlobalPreservationObject[], verifyBeforeMutation: () => Promise<void>) {
  assert.ok(input.length >= 1 && input.length <= 5 && input.filter(row => row.role === 'package').length === 1, 'global_preservation_scope_required');
  const items = structuredClone(input).map(row => ({ ...row, directory: guard.canonicalDirectory(row.directory), backupDirectory: guard.canonicalDirectory(row.backupDirectory) })), steps = new Set<string>(), names = new Set<string>();
  const sources = items.map(row => {
    assert.ok(/^[a-zA-Z0-9._-]{1,56}$/.test(row.step) && !steps.has(row.step), 'global_preservation_step_invalid'); steps.add(row.step);
    assert.ok([row.directory, row.backupDirectory].every(path => isAbsolute(path) && resolve(path) === path), 'global_preservation_absolute_directory_required');
    assert.ok(row.role === 'package' && row.name === 'caveat-cli' || row.role === 'npm-management' && row.name === '.package-lock.json'
      || row.role === 'leaf' && ['caveat', 'caveat.cmd', 'caveat.ps1'].includes(row.name), 'global_preservation_scope_invalid');
    const destination = join(row.backupDirectory, row.backupName);
    assert.ok(!names.has(destination), 'global_preservation_duplicate_destination'); names.add(destination);
    return join(row.directory, row.name);
  });
  for (let index = 0; index < sources.length; index++) {
    for (let other = 0; other < sources.length; other++) if (index !== other) assert.ok(!inside(sources[index]!, sources[other]!), 'global_preservation_overlapping_source');
    for (const row of items) assert.ok(!inside(sources[index]!, row.backupDirectory), 'global_preservation_backup_inside_source');
  }
  const saved = items.map(item => {
    assert.equal(guard.observe(item.backupDirectory, item.backupName), null, 'global_preservation_destination_exists');
    assert.equal(guard.directoryIdentity(item.directory).dev, guard.directoryIdentity(item.backupDirectory).dev, 'global_preservation_cross_volume');
    const tree = guard.retainTree(item.directory, item.name), rows = guard.readTree(tree);
    assert.ok(rows[0]!.identity.kind === (item.role === 'package' ? 'directory' : item.role === 'npm-management' ? 'file' : rows[0]!.identity.kind), 'global_preservation_kind_invalid');
    assert.ok(item.role !== 'leaf' || rows.length === 1 && ['file', 'link'].includes(rows[0]!.identity.kind), 'global_preservation_leaf_invalid');
    if (item.role === 'package') {
      assert.ok(rows.some(row => row.relativePath === 'package.json' && row.identity.kind === 'file'), 'global_preservation_manifest_missing');
      for (const row of rows) if (row.identity.kind === 'link') {
        const target = row.identity.linkTarget;
        assert.ok(target && !isAbsolute(target) && inside(sources[items.indexOf(item)]!, resolve(dirname(join(item.directory, item.name, row.relativePath)), target)), 'global_preservation_external_package_link');
      }
    }
    return { item, tree, rows, state: 'original' as 'original' | 'preserved' | 'restored' | 'unknown' };
  });
  let stopped = false;
  const manifest = () => ({ schema: 'caveat.global_original_objects.v1' as const,
    objects: saved.map(row => ({ ...row.item, state: row.state, rows: structuredClone(row.rows), stateSha256: sha(row.rows) })),
    originalsReconstructed: false as const, automaticRecovery: false as const });
  const move = async (row: typeof saved[number], restore: boolean) => {
    assert.ok(!stopped && row.state === (restore ? 'preserved' : 'original'), 'global_preservation_not_known');
    try {
      await verifyBeforeMutation();
      // Revalidate every known object, not only the next leaf. No unknown object is overwritten.
      for (const known of saved) assert.deepEqual(guard.readTree(known.tree), known.rows, 'global_preservation_original_changed');
    } catch (error) {
      stopped = true; return { status: 'stopped' as const, errorSha256: errorSha(error), manifest: manifest() };
    }
    const step = (restore ? 'restore.' : 'retain.') + row.item.step, operation = restore ? 'restore' as const : 'retain' as const;
    journal.intent(step, operation, sha(manifest()));
    let result: ReturnType<Guard['moveTreeNoReplace']> | undefined, errorSha256: string | undefined;
    try {
      result = guard.moveTreeNoReplace(row.tree, restore ? row.item.directory : row.item.backupDirectory, restore ? row.item.name : row.item.backupName);
      if (result.status === 'moved') { row.rows = guard.readTree(row.tree); row.state = restore ? 'restored' : 'preserved'; }
      else { stopped = true; row.state = 'unknown'; }
    } catch (error) { stopped = true; row.state = 'unknown'; errorSha256 = errorSha(error); }
    const outcome = row.state === 'unknown' ? 'unknown' as const : 'confirmed' as const;
    try { journal.result(step, operation, outcome, sha({ manifest: manifest(), result, errorSha256 })); }
    catch (error) {
      stopped = true;
      return { status: 'unknown' as const, resultRecorded: false, result, errorSha256: errorSha(error), manifest: manifest() };
    }
    return { status: outcome, resultRecorded: true, result, ...(errorSha256 ? { errorSha256 } : {}), manifest: manifest() };
  };
  return {
    manifest,
    async preserveAll() {
      assert.ok(!stopped && saved.every(row => row.state === 'original'), 'global_preservation_not_fresh');
      for (const row of saved) { const result = await move(row, false); if (result.status !== 'confirmed') return result; }
      return { status: 'preserved' as const, manifest: manifest() };
    },
    async restoreKnown(step: string) {
      const row = saved.find(value => value.item.step === step); assert.ok(row, 'global_preservation_unknown_step');
      return move(row, true);
    },
  };
}
