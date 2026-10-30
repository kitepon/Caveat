import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preflightGlobalProcesses, type NativeProcessTables } from '@caveat/core';
import { bindRegistrationAdmission, executeRegistrationAdmission, planRegistrationRecovery, executeRegistrationRecovery, inspectRegistrationJournal } from '../src/registrationMigration.js';
import { registrationFileSpecs } from '../src/registrationProjection.js';
import { registrationFixture } from './registrationFixture.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const f = registrationFixture(); roots.push(f.root); return f; }
function tables(): NativeProcessTables {
  const stat = statSync(process.execPath, { bigint: true }), executable = { path: realpathSync(process.execPath), dev: String(stat.dev), ino: String(stat.ino) };
  const self = { pid: process.pid, ppid: process.ppid, birth: 'fixture', uid: 1000, executable, argv: [process.execPath, 'fixture'] };
  return { before: [self], after: [structuredClone(self)], errors: [], selfPid: process.pid, selfExecutable: executable, caseInsensitive: false };
}
const preflight = (scope: Parameters<typeof preflightGlobalProcesses>[0], emit: Parameters<typeof preflightGlobalProcesses>[1]) => preflightGlobalProcesses(scope, emit, async () => tables());
describe('Main15 standard atomic registration writes', { timeout: 180000 }, () => {
  it('keeps every original name present, backs up original bytes, uses PATH Node, and restores through the existing journal', async () => {
    const f = fixture(), before = readdirSync(f.paths.root), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    expect(readdirSync(f.paths.root)).toEqual(before); expect(admission.plan.files).toHaveLength(7);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, () => {
      for (const file of admission.plan.files) expect(existsSync(file.path)).toBe(true);
    });
    expect(result).toMatchObject({ status: 'completed' }); expect(admission.plan.nodeCommand).toBe('node');
    for (const [index, file] of admission.plan.files.entries()) {
      expect(readFileSync(join(f.paths.root, result.runId!, 'original-' + index))).toEqual(f.original.get(file.path));
      expect(readFileSync(file.path).toString()).toMatch(/node/);
      expect(readFileSync(file.path).toString()).not.toContain(f.input.source.observation.expectedDedicatedNode);
    }
    const recovery = await planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight);
    expect(recovery.status).toBe('ready');
    const restored = await executeRegistrationRecovery(f.home, result.runId!, admission.planSha256, recovery.evidenceSha256, () => {}, preflight);
    expect(restored.status).toBe('restored');
    for (const [file, bytes] of f.original) expect(readFileSync(file)).toEqual(bytes);
  });
  it('checks readable Claude Code writers at admission while counting inaccessible processes without stopping', async () => {
    const f = fixture(), original = readdirSync(f.paths.root), data = tables();
    const config = statSync(join(f.home, '.claude.json'), { bigint: true });
    data.before.push({ ...data.before[0]!, claudeConfig: { dev: String(config.dev), ino: String(config.ino) }, pid: 765432, argv: ['node', '/npm/@anthropic-ai/claude-code/cli.js'] }); data.after = structuredClone(data.before);
    const collect = (scope: Parameters<typeof preflightGlobalProcesses>[0]) => preflightGlobalProcesses(scope, () => {}, async () => data);
    await expect(bindRegistrationAdmission(f.input, () => {}, collect)).rejects.toThrow('process_preflight_stopped');
    data.before[1]!.claudeConfig = null;
    data.before[1]!.argv = null as unknown as string[]; data.before[1]!.executable = null as any; data.after = structuredClone(data.before);
    const admission = await bindRegistrationAdmission({ ...f.input, clientsClosed: false }, () => {}, collect);
    expect(admission.processAssessment()?.status).toBe('ready'); expect(readdirSync(f.paths.root)).toEqual(original);
  });
  it('takes process snapshots before the transaction and runs none between file replacements', async () => {
    const f = fixture(); let calls = 0, replacements = 0;
    const collect = (...args: Parameters<typeof preflight>) => { calls++; expect(replacements).toBe(0); return preflight(...args); };
    const admission = await bindRegistrationAdmission(f.input, () => {}, collect);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => { if (event.event === 'before-atomic-replace') replacements++; });
    expect(result.status).toBe('completed'); expect(calls).toBe(2); expect(replacements).toBe(7);
  });
  it('rejects changed saved paths and original bytes before creating a run', async () => {
    const f = fixture(), source = structuredClone(f.input.source), before = readdirSync(f.paths.root);
    source.observation.files[0].file = '/unapproved'; expect(() => registrationFileSpecs(source, f.home)).toThrow();
    const path = [...f.original.keys()][0]!; writeFileSync(path, 'changed');
    await expect(bindRegistrationAdmission(f.input, () => {}, preflight)).rejects.toThrow('saved_original_changed'); expect(readdirSync(f.paths.root)).toEqual(before);
  });
  it('refuses a configuration parent replaced by an alias after admission without modifying either copy', async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight), directory = join(f.home, '.claude'), moved = directory + '.moved';
    renameSync(directory, moved); symlinkSync(moved, directory, 'junction');
    expect((await executeRegistrationAdmission(admission, admission.planSha256)).status).toBe('stopped');
    expect(readFileSync(join(moved, 'settings.json'))).toEqual(f.original.get(join(directory, 'settings.json')));
  });
  it('keeps a confirmed partial write recoverable and leaves the old journal untouched', async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => {
      if (event.phase === 'replace.0' && event.event === 'completed') throw Error('controlled interruption after confirmed file');
    });
    expect(result.status).toBe('unknown');
    const journalPath = join(f.paths.root, result.runId!, 'journal.jsonl'), journal = readFileSync(journalPath);
    const plan = await planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight);
    expect((await executeRegistrationRecovery(f.home, result.runId!, admission.planSha256, plan.evidenceSha256, () => {}, preflight)).status).toBe('restored');
    expect(readFileSync(journalPath)).toEqual(journal);
    for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
  });
  it('retains backup and the original name after interruption before rename, and refuses a pending journal as execution authority', async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => { if (event.event === 'before-atomic-replace') throw Error('before rename'); });
    expect(result.status).toBe('unknown');
    expect(await inspectRegistrationJournal(f.home, result.runId!, admission.planSha256)).toMatchObject({ journalStatus: 'pending', executionPermission: false });
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('pending_torn_or_unknown');
    for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(join(f.paths.root, result.runId!, 'original-0'))).toEqual(f.original.get(admission.plan.files[0]!.path));
  });
  it('never overwrites a config changed after migration, and rejects changed source evidence', async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256);
    const plan = await planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight);
    const path = admission.plan.files[0]!.path; writeFileSync(path, 'new user content');
    expect((await executeRegistrationRecovery(f.home, result.runId!, admission.planSha256, plan.evidenceSha256, () => {}, preflight)).status).toBe('stopped'); expect(readFileSync(path, 'utf8')).toBe('new user content');
    appendFileSync(join(f.paths.root, result.runId!, 'journal.jsonl'), '{torn');
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('pending_torn_or_unknown');
  });
});
