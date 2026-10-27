import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bindGlobalPathGuard, openGlobalPathGuard, type NativeGuardDriver } from '../src/managedGlobalGuard.js';
import { createGlobalMutationJournal, parseGlobalMutationJournal } from '../src/managedGlobalJournal.js';
import { globalFilesystemNativeSpec, isWindows } from '../src/platform.js';
import { createPosixGlobalGuard } from '../src/managedPosixGuard.js';
import { createWindowsGlobalGuard } from '../src/managedWindowsGuard.js';
import { runWindowsAclPrivateTree } from '../src/privateWindowsAcl.js';

const roots: string[] = [], plan = 'a'.repeat(64), state = 'b'.repeat(64);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'caveat-journal-'))); roots.push(root);
  const dir = join(root, 'private'); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'original'), 'protected bytes', { mode: 0o600 });
  if (isWindows()) runWindowsAclPrivateTree(root);
  return { root, dir };
}
async function driver(): Promise<NativeGuardDriver> {
  const spec = globalFilesystemNativeSpec(); return spec.windows ? createWindowsGlobalGuard() : createPosixGlobalGuard(spec);
}
describe('native private global mutation journal', () => {
  it('flushes chained intent/result and completion into an exclusive private file', async () => {
    const { dir } = fixture(), guard = await openGlobalPathGuard([dir]);
    try {
      const journal = createGlobalMutationJournal(guard, dir, 'run.jsonl', plan);
      expect(journal.intent('package', 'retain', state).status).toBe('pending');
      expect(journal.result('package', 'retain', 'confirmed', state).status).toBe('ready');
      expect(journal.complete(state).status).toBe('complete');
      const bytes = guard.readPersistedJournal(dir, 'run.jsonl');
      expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
      expect(parseGlobalMutationJournal(bytes, plan).records).toHaveLength(3);
      expect(readFileSync(join(dir, 'original'), 'utf8')).toBe('protected bytes');
      if (!isWindows()) expect(statSync(join(dir, 'run.jsonl')).mode & 0o777).toBe(0o600);
      const before = Buffer.from(bytes);
      expect(() => createGlobalMutationJournal(guard, dir, 'run.jsonl', plan)).toThrow();
      expect(readFileSync(join(dir, 'run.jsonl'))).toEqual(before);
      expect(() => guard.createJournal(dir, 'original', Buffer.from('overwrite'))).toThrow();
      expect(readFileSync(join(dir, 'original'), 'utf8')).toBe('protected bytes');
    } finally { guard.close(); }
  });
  it('persists intent before a real retained-leaf move and records the bound result afterward', async () => {
    const { dir } = fixture(), native = await driver(); let flushed: string | null = null, renameCalls = 0;
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const guard = bindGlobalPathGuard([dir], { ...native,
      flushJournal(ref) { native.flushJournal(ref); flushed = digest(native.readJournal(ref)); },
      rename(...args) {
        const bytes = readFileSync(join(dir, 'move.jsonl'));
        expect(digest(bytes)).toBe(flushed); expect(parseGlobalMutationJournal(bytes, plan).status).toBe('pending');
        renameCalls++; native.rename(...args);
      },
    });
    try {
      const journal = createGlobalMutationJournal(guard, dir, 'move.jsonl', plan), original = guard.retain(dir, 'original');
      journal.intent('original', 'retain', digest(Buffer.from(JSON.stringify(original.identity))));
      const result = guard.moveNoReplace(original, dir, 'saved');
      expect(result.status, result.status === 'unknown' ? result.phase + ':' + result.nativeCode : '').toBe('moved');
      if (result.status !== 'moved') throw Error('owned_move_unconfirmed');
      journal.result('original', 'retain', 'confirmed', digest(Buffer.from(JSON.stringify(result.after)))); journal.complete(state);
      expect(renameCalls).toBe(1); expect(readFileSync(join(dir, 'saved'), 'utf8')).toBe('protected bytes');
      expect(journal.read().status).toBe('complete');
    } finally { guard.close(); }
  });
  it('keeps an interrupted intent pending after handles close and refuses automatic replay or overwrite', async () => {
    const { dir } = fixture(); let guard = await openGlobalPathGuard([dir]);
    const journal = createGlobalMutationJournal(guard, dir, 'interrupted.jsonl', plan);
    journal.intent('npm', 'uninstall', state); guard.close();
    guard = await openGlobalPathGuard([dir]);
    try {
      const bytes = guard.readPersistedJournal(dir, 'interrupted.jsonl'), parsed = parseGlobalMutationJournal(bytes, plan);
      expect(parsed.status).toBe('pending'); expect(parsed.pending?.operation).toBe('uninstall');
      expect(() => createGlobalMutationJournal(guard, dir, 'interrupted.jsonl', plan)).toThrow();
      expect(guard.readPersistedJournal(dir, 'interrupted.jsonl')).toEqual(bytes);
    } finally { guard.close(); }
  });
  it('seals unknown outcomes and refuses a second action before the first result', async () => {
    const { dir } = fixture(), guard = await openGlobalPathGuard([dir]);
    try {
      const journal = createGlobalMutationJournal(guard, dir, 'unknown.jsonl', plan);
      expect(() => journal.result('pkg', 'retain', 'confirmed', state)).toThrow('result_invalid');
      journal.intent('pkg', 'retain', state);
      expect(() => journal.intent('leaf', 'wrapper', state)).toThrow('intent_invalid');
      expect(journal.result('pkg', 'retain', 'unknown', null).status).toBe('unknown');
      const bytes = guard.readPersistedJournal(dir, 'unknown.jsonl');
      expect(() => journal.intent('leaf', 'wrapper', state)).toThrow('after_terminal');
      expect(() => journal.complete(state)).toThrow('after_terminal');
      expect(guard.readPersistedJournal(dir, 'unknown.jsonl')).toEqual(bytes);
    } finally { guard.close(); }
  });
  it('refuses writes and flushes through original, read-only and closed native references', async () => {
    const { dir } = fixture(), native = await driver(); let original: object | null = null, created: object | null = null, observed = false;
    const guard = bindGlobalPathGuard([dir], { ...native,
      openChild(parent, name, purpose) {
        const ref = native.openChild(parent, name, purpose);
        if (name === 'original' && purpose === 'mutation') original = ref;
        if (ref && purpose === 'journal-read') {
          observed = true; expect(() => native.appendJournal(ref, Buffer.from('forbidden'))).toThrow('owned_creation_required');
          expect(() => native.flushJournal(ref)).toThrow('owned_creation_required');
        }
        return ref;
      },
      createJournal(parent, name) { created = native.createJournal(parent, name); return created; },
    });
    try {
      const sourceToken = guard.retain(dir, 'original'); expect(original).not.toBeNull();
      expect(() => native.appendJournal(original!, Buffer.from('forbidden'))).toThrow('owned_creation_required');
      expect(() => native.flushJournal(original!)).toThrow('owned_creation_required');
      expect(() => guard.appendJournal(sourceToken as never, Buffer.from('forbidden'))).toThrow('failed_token');
      const token = guard.createJournal(dir, 'owned.jsonl', Buffer.from('header\n'));
      expect(guard.readPersistedJournal(dir, 'owned.jsonl')).toEqual(guard.readJournal(token)); expect(observed).toBe(true);
      expect(() => guard.appendJournal({ journal: true }, Buffer.from('foreign-token'))).toThrow('failed_token');
    } finally { guard.close(); }
    expect(() => native.appendJournal(created!, Buffer.from('closed'))).toThrow('owned_creation_required');
    expect(readFileSync(join(dir, 'original'), 'utf8')).toBe('protected bytes');
  });
  it('keeps a partial append as torn evidence and prevents further writes in the failed session', async () => {
    const { dir } = fixture(), native = await driver(); let fail = false;
    const guard = bindGlobalPathGuard([dir], { ...native, appendJournal(ref, bytes) {
      native.appendJournal(ref, fail ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes);
      if (fail) throw Error('owned-partial-fixture');
    } });
    try {
      const token = guard.createJournal(dir, 'torn.jsonl', Buffer.from(JSON.stringify({ schema: 'caveat.global_journal.v1', planSha256: plan, runId: '1'.repeat(32) }) + '\n'));
      fail = true; expect(() => guard.appendJournal(token, Buffer.from('{"unfinished":1}\n'))).toThrow('owned-partial-fixture');
      expect(() => guard.appendJournal(token, Buffer.from('retry\n'))).toThrow('failed_token');
      const bytes = guard.readPersistedJournal(dir, 'torn.jsonl'); expect(parseGlobalMutationJournal(bytes, plan).status).toBe('torn');
      expect(readFileSync(join(dir, 'original'), 'utf8')).toBe('protected bytes');
    } finally { guard.close(); }
  });
  it('treats a failed flush as unconfirmed and never issues another append', async () => {
    const { dir } = fixture(), native = await driver(); let fail = false, writes = 0;
    const guard = bindGlobalPathGuard([dir], { ...native,
      appendJournal(ref, bytes) { writes++; native.appendJournal(ref, bytes); },
      flushJournal(ref) { native.flushJournal(ref); if (fail) throw Error('owned-flush-fixture'); },
    });
    try {
      const token = guard.createJournal(dir, 'flush.jsonl', Buffer.from('header\n')); fail = true;
      expect(() => guard.appendJournal(token, Buffer.from('intent\n'))).toThrow('owned-flush-fixture');
      expect(() => guard.appendJournal(token, Buffer.from('retry\n'))).toThrow('failed_token'); expect(writes).toBe(2);
    } finally { guard.close(); }
  });
});

describe('journal trust boundary', () => {
  const header = () => JSON.stringify({ schema: 'caveat.global_journal.v1', planSha256: plan, runId: '1'.repeat(32) }) + '\n';
  it('rejects the wrong plan, noncanonical duplicate keys, invalid chains and malformed headers', () => {
    expect(() => parseGlobalMutationJournal(Buffer.from(header()), state)).toThrow('header_invalid');
    expect(() => parseGlobalMutationJournal(Buffer.from(header().replace('"schema":', '"schema":"duplicate","schema":')), plan)).toThrow('noncanonical');
    expect(() => parseGlobalMutationJournal(Buffer.from('null\n'), plan)).toThrow('object_required');
    const row = { sequence: 2, previousSha256: createHash('sha256').update(header()).digest('hex'), kind: 'intent', step: 'pkg', operation: 'retain', stateSha256: state };
    expect(() => parseGlobalMutationJournal(Buffer.from(header() + JSON.stringify(row) + '\n'), plan)).toThrow('chain_invalid');
    expect(() => parseGlobalMutationJournal(Buffer.alloc(16 * 1024 * 1024 + 1), plan)).toThrow('total_bound');
    try { parseGlobalMutationJournal(Buffer.from('private-secret-invalid-json\n'), plan); throw Error('fixture_expected_failure'); }
    catch (error) { expect(String(error)).not.toContain('private-secret'); expect(String(error)).toContain('json_invalid'); }
  });
});


describe('new private files sealed for publication', () => {
  it('seals only owned journals, forbids further writes, and publishes an executable file and complete manifest directory', async () => {
    const { root, dir } = fixture(), guard = await openGlobalPathGuard([root, dir]);
    try {
      const original = guard.retain(dir, 'original');
      expect(() => guard.sealJournalFile(original as never, true)).toThrow('unknown_or_failed_token');
      const journal = guard.createJournal(dir, 'new-wrapper', Buffer.from('#!/bin/sh\nexit 0\n'));
      const sealed = guard.sealJournalFile(journal, true); expect(sealed.status, JSON.stringify({ phase: sealed.phase, errorSha256: sealed.errorSha256 })).toBe('sealed');
      expect(() => guard.appendJournal(journal, Buffer.from('bad'))).toThrow('unknown_or_failed_token');
      expect(guard.moveTreeNoReplace(sealed.tree!, root, 'wrapper').status).toBe('moved');
      expect(readFileSync(join(root, 'wrapper'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
      if (!isWindows()) expect(statSync(join(root, 'wrapper')).mode & 0o777).toBe(0o700);
      const staged = guard.createPrivateDirectory(dir, 'new-shell');
      const file = guard.sealJournalFile(guard.createJournal(staged, 'manifest.json', Buffer.from('{}\n')), false);
      expect(file.status).toBe('sealed'); guard.releaseWorkingTree(file.tree!);
      const directory = guard.sealPrivateDirectory(staged); expect(directory.status, JSON.stringify({ phase: directory.phase, errorSha256: directory.errorSha256 })).toBe('sealed');
      expect(guard.moveTreeNoReplace(directory.tree!, root, 'shell').status).toBe('moved');
      expect(readFileSync(join(root, 'shell/manifest.json'), 'utf8')).toBe('{}\n');
      expect(() => guard.sealPrivateDirectory(dir)).toThrow('new_directory_required');
      expect(readFileSync(join(dir, 'original'), 'utf8')).toBe('protected bytes');
    } finally { guard.close(); }
  });
  it('retains a new file and reports unknown if closing its write handle is unconfirmed', async () => {
    const { dir } = fixture(), native = await driver(); let fail = false, target: object;
    const guard = bindGlobalPathGuard([dir], { ...native, createJournal(...args) { target = native.createJournal(...args); return target; },
      close(ref) { native.close(ref); if (fail && ref === target) { fail = false; throw Error('close unconfirmed'); } } });
    try {
      const token = guard.createJournal(dir, 'new-wrapper', Buffer.from('new bytes')); fail = true;
      expect(guard.sealJournalFile(token, true).status).toBe('unknown');
      expect(() => guard.readJournal(token)).toThrow('unknown_or_failed_token');
      expect(readFileSync(join(dir, 'new-wrapper'), 'utf8')).toBe('new bytes');
    } finally { guard.close(); }
  });
});
