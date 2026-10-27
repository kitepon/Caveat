import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GlobalGuardTree, GlobalGuardTreeRow, openGlobalPathGuard } from './managedGlobalGuard.js';
import type { GlobalNpmReceipt } from './managedGlobalNpm.js';
import type { GlobalJournalOperation, createGlobalMutationJournal } from './managedGlobalJournal.js';

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

/** An untouched original already satisfies the same ordering as a restored one. */
export function assertGlobalRestoreOrder(objects: { role: string; state: string }[], role: string) {
  const original = (state: string) => state === 'original' || state === 'restored';
  if (role !== 'package') assert.ok(objects.filter(row => row.role === 'package').every(row => original(row.state)), 'global_preservation_package_restore_required');
  if (role === 'leaf') assert.ok(objects.filter(row => row.role === 'npm-management').every(row => original(row.state)), 'global_preservation_management_restore_required');
}

/** Exclusive private evidence shared by the plan, original manifest and operation state. */
export function writeGlobalPrivateEvidence(guard: Guard, directory: string, name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024, 'global_preservation_manifest_bound');
  const token = guard.createJournal(directory, name, bytes.subarray(0, 65536));
  for (let offset = 65536; offset < bytes.length; offset += 65536) guard.appendJournal(token, bytes.subarray(offset, offset + 65536));
  assert.ok(guard.readJournal(token).equals(bytes), 'global_preservation_manifest_readback_changed');
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Internal engine: the caller must bind fresh package/protected-state/process checks; no CLI bypass exists. */
export function prepareGlobalObjectPreservation(guard: Guard, journal: Journal, input: GlobalPreservationObject[], verifyBeforeMutation: () => Promise<void>) {
  assert.ok(input.length >= 1 && input.length <= 5 && input.filter(row => row.role === 'package').length === 1, 'global_preservation_scope_required');
  const items = structuredClone(input).map(row => ({ ...row, directory: guard.canonicalDirectory(row.directory), backupDirectory: guard.canonicalDirectory(row.backupDirectory) })), steps = new Set<string>(), names = new Set<string>();
  assert.equal(new Set(items.map(row => row.role + ':' + row.name)).size, items.length, 'global_preservation_duplicate_role');
  const packageDirectory = items.find(row => row.role === 'package')!.directory;
  assert.ok(items.filter(row => row.role === 'npm-management').every(row => row.directory === packageDirectory), 'global_preservation_management_scope');
  items.sort((a, b) => ['package', 'npm-management', 'leaf'].indexOf(a.role) - ['package', 'npm-management', 'leaf'].indexOf(b.role));
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
  for (const directory of new Set(items.map(item => item.backupDirectory))) guard.assertPrivateDirectory(directory);
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
    return { item, tree, rows, working: null as null | { status: 'known' | 'released' | 'after-known' | 'absent' | 'unknown' | 'quarantined'; rows: GlobalGuardTreeRow[] | null; stagingName: string }, state: 'original' as 'original' | 'preserved' | 'restored' | 'unknown' };
  });
  const workingTrees = new Map<string, GlobalGuardTree>();
  let stopped = false;
  const initial = journal.read();
  assert.equal(initial.status, 'ready', 'global_preservation_fresh_journal_required');
  assert.equal(initial.records.length, 0, 'global_preservation_fresh_journal_required');
  const evidenceDirectory = items[0]!.backupDirectory;
  assert.ok(items.every(item => item.backupDirectory === evidenceDirectory), 'global_preservation_one_private_backup_required');
  const persist = (name: string, value: unknown) => writeGlobalPrivateEvidence(guard, evidenceDirectory, name, value);
  const originalEvidence = persist('originals-' + initial.header.runId + '.json', {
    schema: 'caveat.global_original_evidence.v1', planSha256: initial.header.planSha256, runId: initial.header.runId,
    objects: saved.map(row => ({ ...row.item, rows: row.rows })),
  });
  const manifest = () => ({ schema: 'caveat.global_original_objects.v1' as const,
    objects: saved.map(row => ({ ...row.item, state: row.state, working: structuredClone(row.working), rows: structuredClone(row.rows), stateSha256: sha(row.rows) })),
    originalEvidence: structuredClone(originalEvidence), originalsReconstructed: false as const, automaticRecovery: false as const });
  const verify = async () => {
    await verifyBeforeMutation();
    assert.equal(createHash('sha256').update(guard.readPersistedJournal(evidenceDirectory, originalEvidence.name)).digest('hex'), originalEvidence.sha256, 'global_preservation_original_evidence_changed');
    for (const known of saved) {
      assert.deepEqual(guard.readTree(known.tree), known.rows, 'global_preservation_original_changed');
      if (known.working?.status === 'known' || known.working?.status === 'after-known' || known.working?.status === 'quarantined') assert.deepEqual(guard.readTree(workingTrees.get(known.item.step)!), known.working.rows, 'global_preservation_working_changed');
    }
  };
  const record = (step: string, operation: GlobalJournalOperation, outcome: 'confirmed' | 'unknown', result: unknown, errorSha256?: string) => {
    const evidence = persist('state-' + initial.header.runId + '-' + journal.read().nextSequence + '.json', {
      schema: 'caveat.global_preservation_state.v1', planSha256: initial.header.planSha256, runId: initial.header.runId,
      step, operation, manifest: manifest(), result, errorSha256,
    });
    journal.result(step, operation, outcome, evidence.sha256);
  };
  const move = async (row: typeof saved[number], restore: boolean) => {
    assert.ok(!stopped && row.state === (restore ? 'preserved' : 'original'), 'global_preservation_not_known');
    try {
      await verify();
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
    try {
      record(step, operation, outcome, result, errorSha256);
    }
    catch (error) {
      stopped = true;
      return { status: 'unknown' as const, resultRecorded: false, result, errorSha256: errorSha(error), manifest: manifest() };
    }
    return { status: outcome, resultRecorded: true, result, ...(errorSha256 ? { errorSha256 } : {}), manifest: manifest() };
  };
  return {
    manifest,
    async verifyCurrent() {
      assert.ok(!stopped, 'global_preservation_not_known');
      try { await verify(); } catch (error) { stopped = true; throw error; }
    },
    async preserveAll() {
      assert.ok(!stopped && saved.every(row => row.state === 'original'), 'global_preservation_not_fresh');
      for (const row of saved) { const result = await move(row, false); if (result.status !== 'confirmed') return result; }
      return { status: 'preserved' as const, manifest: manifest() };
    },
    async createWorkingCopies() {
      assert.ok(!stopped && saved.every(row => row.state === 'preserved' && !row.working), 'global_preservation_not_ready_for_working_copy');
      for (const row of saved) {
        try { await verify(); } catch (error) { stopped = true; return { status: 'stopped' as const, errorSha256: errorSha(error), manifest: manifest() }; }
        const step = 'copy.' + row.item.step, stagingName = 'work-' + initial.header.runId + '-' + row.item.step;
        journal.intent(step, 'working-copy', sha(manifest()));
        let result: ReturnType<Guard['copyTreeNoReplace']> | undefined, errorSha256: string | undefined;
        try {
          result = guard.copyTreeNoReplace(row.tree, row.item.directory, row.item.name, row.item.backupDirectory, stagingName);
          row.working = { status: result.status === 'copied' ? 'known' : 'unknown', rows: result.status === 'copied' ? result.rows : null, stagingName };
          if (result.status === 'copied') workingTrees.set(row.item.step, result.tree); else stopped = true;
        } catch (error) { stopped = true; errorSha256 = errorSha(error); row.working = { status: 'unknown', rows: null, stagingName }; }
        const outcome = row.working!.status === 'known' ? 'confirmed' : 'unknown';
        try { record(step, 'working-copy', outcome, result, errorSha256); }
        catch (error) { stopped = true; return { status: 'unknown' as const, resultRecorded: false, errorSha256: errorSha(error), manifest: manifest() }; }
        if (outcome === 'unknown') return { status: 'unknown' as const, result, manifest: manifest() };
      }
      return { status: 'working' as const, manifest: manifest() };
    },
    async uninstallWorking(run: () => Promise<GlobalNpmReceipt>) {
      assert.ok(!stopped && saved.every(row => row.state === 'preserved' && row.working?.status === 'known'), 'global_preservation_uninstall_not_ready');
      try { await verify(); } catch (error) { stopped = true; return { status: 'stopped' as const, errorSha256: errorSha(error), manifest: manifest() }; }
      journal.intent('npm-uninstall', 'uninstall', sha(manifest()));
      let receipt: GlobalNpmReceipt | undefined, errorSha256: string | undefined;
      const after: { step: string; state: 'unobserved' | 'present' | 'absent'; identity?: GlobalGuardTreeRow['identity']; rows?: GlobalGuardTreeRow[] }[] = saved.map(row => ({ step: row.item.step, state: 'unobserved' }));
      try {
        for (const row of saved) { guard.releaseWorkingTree(workingTrees.get(row.item.step)!); workingTrees.delete(row.item.step); row.working!.status = 'released'; }
        receipt = await run();
        assert.ok(receipt.spawned && receipt.exitObserved && receipt.closeObserved && !receipt.terminationRequested && !receipt.signal, 'global_preservation_npm_terminal_unknown');
        await verify();
        for (const row of saved) {
          const observed = guard.observe(row.item.directory, row.item.name);
          const observation = after.find(value => value.step === row.item.step)!;
          if (!observed) { observation.state = 'absent'; row.working = { ...row.working!, status: 'absent', rows: null }; continue; }
          observation.state = 'present'; observation.identity = observed;
          const token = guard.retainTree(row.item.directory, row.item.name), rows = guard.readTree(token), before = new Map(row.working!.rows!.map(value => [value.relativePath, value.identity]));
          observation.rows = rows;
          assert.ok(rows.length <= before.size, 'global_preservation_npm_new_object');
          for (const value of rows) {
            const expected = before.get(value.relativePath); assert.ok(expected, 'global_preservation_npm_new_object');
            const stable = (identity: typeof value.identity) => {
              const { ctime: _, ...file } = identity;
              if (identity.kind !== 'directory') return file;
              const { mtime: __, links: ___, size: ____, ...directory } = file; return directory;
            };
            assert.deepEqual(stable(value.identity), stable(expected), 'global_preservation_npm_unknown_after');
          }
          workingTrees.set(row.item.step, token); row.working = { ...row.working!, status: 'after-known', rows };
        }
      } catch (error) { stopped = true; errorSha256 = errorSha(error); for (const row of saved) if (row.working?.status === 'released') row.working.status = 'unknown'; }
      const outcome = stopped ? 'unknown' : 'confirmed';
      try { record('npm-uninstall', 'uninstall', outcome, { receipt, after }, errorSha256); }
      catch (error) { stopped = true; return { status: 'unknown' as const, resultRecorded: false, receipt, errorSha256: errorSha(error), manifest: manifest() }; }
      if (stopped) return { status: 'unknown' as const, receipt, after, errorSha256, manifest: manifest() };
      const removed = saved.filter(row => row.item.role !== 'npm-management').every(row => row.working?.status === 'absent');
      return { status: receipt?.status === 'completed' && removed ? 'removed' as const : 'failed-known' as const, receipt, after, manifest: manifest() };
    },
    async quarantineWorking(step: string) {
      const row = saved.find(value => value.item.step === step);
      assert.ok(!stopped && (row?.working?.status === 'known' || row?.working?.status === 'after-known'), 'global_preservation_no_known_working_copy');
      try { await verify(); } catch (error) { stopped = true; return { status: 'stopped' as const, errorSha256: errorSha(error), manifest: manifest() }; }
      const action = 'retire.' + step; journal.intent(action, 'working-copy', sha(manifest()));
      let result: ReturnType<Guard['moveTreeNoReplace']> | undefined, errorSha256: string | undefined;
      try {
        const token = workingTrees.get(step)!;
        result = guard.moveTreeNoReplace(token, row.item.backupDirectory, 'used-' + row.working.stagingName);
        if (result.status === 'moved') row.working = { ...row.working, status: 'quarantined', rows: guard.readTree(token) };
        else { stopped = true; row.working.status = 'unknown'; }
      } catch (error) { stopped = true; row.working.status = 'unknown'; errorSha256 = errorSha(error); }
      const outcome = row.working.status === 'quarantined' ? 'confirmed' : 'unknown';
      try { record(action, 'working-copy', outcome, result, errorSha256); }
      catch (error) { stopped = true; return { status: 'unknown' as const, resultRecorded: false, errorSha256: errorSha(error), manifest: manifest() }; }
      return { status: outcome, result, manifest: manifest() };
    },
    async restoreKnown(step: string) {
      const row = saved.find(value => value.item.step === step); assert.ok(row, 'global_preservation_unknown_step');
      assert.ok(!row.working || row.working.status === 'quarantined' || row.working.status === 'absent', 'global_preservation_working_copy_present');
      assertGlobalRestoreOrder(saved.map(value => ({ role: value.item.role, state: value.state })), row.item.role);
      return move(row, true);
    },
  };
}
