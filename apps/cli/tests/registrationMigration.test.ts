import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, statSync, readdirSync, realpathSync, writeFileSync, appendFileSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { preflightGlobalProcesses, type NativeProcessTables, isWindows } from '@caveat/core';
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
describe('seven-file fifteen-token native registration migration', () => {
  it('plans without a run/lock then preserves exact original objects and restores them through a new journal', { timeout: 180000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    expect(readdirSync(f.paths.root)).toEqual(before); expect(admission.plan.files).toHaveLength(7);
    const result = await executeRegistrationAdmission(admission, admission.planSha256);
    expect(result).toMatchObject({ status: 'completed' });
    for (const file of admission.plan.files) {
      expect(statSync(join(f.paths.root, result.runId!, 'original-' + admission.plan.files.indexOf(file)), { bigint: true }).ino.toString()).toBe(f.input.source.observation.files.find((row: any) => row.file === file.path).ino);
      expect(readFileSync(file.path).equals(f.original.get(file.path)!)).toBe(false);
    }
    const plan = await planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight);
    expect(plan.status).toBe('ready');
    const recovery = await executeRegistrationRecovery(f.home, result.runId!, admission.planSha256, plan.evidenceSha256, () => {}, preflight, true);
    expect(recovery).toMatchObject({ status: 'restored' });
    for (const [path, bytes] of f.original) { expect(readFileSync(path)).toEqual(bytes); expect(String(statSync(path, { bigint: true }).ino)).toBe(f.input.source.observation.files.find((row: any) => row.file === path).ino); }
  });
  it('requires explicit closure of all seven-file config writers before creating an attempt', { timeout: 60000 }, async () => {
    const f = fixture(); f.input.clientsClosed = false;
    const admission = await bindRegistrationAdmission(f.input, () => {}, preflight), before = readdirSync(f.paths.root);
    expect(admission.plan.clientsToClose.map(row => row.client)).toEqual(['claude', 'codex', 'grok', 'cursor']);
    expect(admission.plan.clientsToClose.flatMap(row => row.files)).toHaveLength(7);
    expect(await executeRegistrationAdmission(admission, admission.planSha256)).toMatchObject({ status: 'stopped', runId: null });
    expect(readdirSync(f.paths.root)).toEqual(before);
  });
  it('keeps process probes and queued callbacks outside both same-file rename pairs', { timeout: 180000 }, async () => {
    const f = fixture(); let vacant = false;
    const checked = (scope: Parameters<typeof preflight>[0], emit: Parameters<typeof preflight>[1]) => {
      for (const path of f.original.keys()) expect(existsSync(path)).toBe(true);
      return preflight(scope, emit);
    };
    const admission = await bindRegistrationAdmission(f.input, () => {}, checked);
    const observer = (event: { phase: string; event: string }) => {
      if (/^(retain|quarantine)\./.test(event.phase) && event.event === 'completed') {
        queueMicrotask(() => { if ([...f.original.keys()].some(path => !existsSync(path))) vacant = true; });
      }
    };
    const migrated = await executeRegistrationAdmission(admission, admission.planSha256, observer);
    expect(migrated.status).toBe('completed'); expect(vacant).toBe(false);
    const plan = await planRegistrationRecovery(f.home, migrated.runId!, admission.planSha256, () => {}, checked);
    const before = readdirSync(f.paths.root);
    expect(await executeRegistrationRecovery(f.home, migrated.runId!, admission.planSha256, plan.evidenceSha256, observer, checked)).toMatchObject({ status: 'stopped', runId: null });
    expect(readdirSync(f.paths.root)).toEqual(before);
    expect((await executeRegistrationRecovery(f.home, migrated.runId!, admission.planSha256, plan.evidenceSha256, observer, checked, true)).status).toBe('restored');
    expect(vacant).toBe(false);
  });
  it('rejects an edited saved path or role instead of granting authority to that path', { timeout: 60000 }, () => {
    const f = fixture(), altered = structuredClone(f.input.source);
    altered.observation.definitions[0].source_file = join(f.home, 'foreign.json');
    altered.proposal.changes[0].source_file = join(f.home, 'foreign.json');
    expect(() => registrationFileSpecs(altered, f.home)).toThrow('unapproved_file');
    const roleOnly = structuredClone(f.input.source), hook = roleOnly.observation.definitions.find((row: any) => row.kind === 'hook');
    const change = roleOnly.proposal.changes.find((row: any) => row.id === hook.id);
    for (const row of [hook, change]) { row.json_pointer = '/hooks/constructor/0/hooks/0/command'; row.id = row.client + ':hook:' + row.json_pointer; }
    expect(() => registrationFileSpecs(roleOnly, f.home)).toThrow('hook_pointer_invalid');
  });
  it('stops on changed original identity or an unknown writer before creating a run or installer lock', { timeout: 60000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root);
    const blocked = () => Promise.resolve({ status: 'stopped' as const } as Awaited<ReturnType<typeof preflightGlobalProcesses>>);
    await expect(bindRegistrationAdmission(f.input, () => {}, blocked)).rejects.toThrow('process_preflight_stopped');
    expect(readdirSync(f.paths.root)).toEqual(before);
    const file = f.input.source.observation.files[0].file; appendFileSync(file, ' ');
    await expect(bindRegistrationAdmission(f.input, () => {}, preflight)).rejects.toThrow(); expect(readdirSync(f.paths.root)).toEqual(before);
  });
  it('keeps a confirmed partial migration and restores it with every old evidence byte unchanged', { timeout: 180000 }, async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => { if (event.phase === 'publish.1' && event.event === 'completed') throw Error('fixture confirmed stop'); });
    expect(result.status).toBe('unknown');
    const dir = join(f.paths.root, result.runId!), source = new Map(readdirSync(dir).filter(name => /^(?:plan|seed|journal|state-)/.test(name)).map(name => [name, readFileSync(join(dir, name))]));
    const plan = await planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight);
    const restored = await executeRegistrationRecovery(f.home, result.runId!, admission.planSha256, plan.evidenceSha256, () => {}, preflight, true);
    expect(restored.status).toBe('restored');
    for (const [name, bytes] of source) expect(readFileSync(join(dir, name))).toEqual(bytes);
    for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
  });
  it('preserves a pending intent, inspects it without granting execution and refuses fresh recovery', { timeout: 120000 }, async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => { if (event.phase === 'publish.0' && event.event === 'intent-durable') throw Error('fixture pending stop'); });
    expect(result.status).toBe('unknown');
    expect(await inspectRegistrationJournal(f.home, result.runId!, admission.planSha256)).toMatchObject({ journalStatus: 'pending', currentObjects: 'not-assessed', executionPermission: false });
    const before = readdirSync(f.paths.root);
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('pending_torn_or_unknown');
    expect(readdirSync(f.paths.root)).toEqual(before);
  });
  it('continues a confirmed partial recovery through another source journal and refuses the stale plan', { timeout: 240000 }, async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const applied = await executeRegistrationAdmission(admission, admission.planSha256);
    const plan = await planRegistrationRecovery(f.home, applied.runId!, admission.planSha256, () => {}, preflight);
    const partial = await executeRegistrationRecovery(f.home, applied.runId!, admission.planSha256, plan.evidenceSha256,
      event => { if (event.phase === 'restore.0' && event.event === 'completed') throw Error('fixture confirmed recovery stop'); }, preflight, true);
    expect(partial.status).toBe('unknown');
    const seedPath = join(f.paths.root, partial.runId!, 'seed.json'), seedBytes = readFileSync(seedPath), cyclic = JSON.parse(seedBytes.toString());
    cyclic.source.run = partial.runId; writeFileSync(seedPath, JSON.stringify(cyclic) + '\n');
    await expect(planRegistrationRecovery(f.home, partial.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('cycle_or_bound');
    writeFileSync(seedPath, seedBytes);
    const journalPath = join(f.paths.root, partial.runId!, 'journal.jsonl'), journalBytes = readFileSync(journalPath), lines = journalBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
    lines[0].runId = JSON.parse(readFileSync(join(f.paths.root, applied.runId!, 'journal.jsonl'), 'utf8').split('\n')[0]!).runId;
    for (let index = 1; index < lines.length; index++) lines[index].previousSha256 = createHash('sha256').update(JSON.stringify(lines[index - 1]) + '\n').digest('hex');
    writeFileSync(journalPath, lines.map(row => JSON.stringify(row)).join('\n') + '\n');
    await expect(planRegistrationRecovery(f.home, partial.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('reused_source_journal');
    writeFileSync(journalPath, journalBytes);
    const stale = await executeRegistrationRecovery(f.home, applied.runId!, admission.planSha256, plan.evidenceSha256, () => {}, preflight, true);
    expect(stale.status).toBe('stopped');
    const fresh = await planRegistrationRecovery(f.home, partial.runId!, admission.planSha256, () => {}, preflight);
    const final = await executeRegistrationRecovery(f.home, partial.runId!, admission.planSha256, fresh.evidenceSha256, () => {}, preflight, true);
    expect(final.status).toBe('restored');
    for (const [path, bytes] of f.original) expect(readFileSync(path)).toEqual(bytes);
  });
  it('rejects changed source evidence or a replacement config without overwriting either object', { timeout: 180000 }, async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => { if (event.phase === 'retain.0' && event.event === 'completed') throw Error('fixture vacant source'); });
    const path = admission.plan.files[0]!.path; writeFileSync(path, 'foreign configuration', { mode: 0o600 });
    const before = readdirSync(f.paths.root);
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('foreign configuration'); expect(readdirSync(f.paths.root)).toEqual(before);
    appendFileSync(join(f.paths.root, result.runId!, 'state-2.json'), ' ');
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('state_hash_changed');
  });
  it('does not report completed after its new directory is moved and replaced with an alias after close', { timeout: 120000 }, async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => {
      if (event.phase === 'readback' && event.event === 'issued') {
        const dir = join(f.paths.root, event.runId!); renameSync(dir, dir + '.moved'); symlinkSync(dir + '.moved', dir, isWindows() ? 'junction' : 'dir');
      }
    });
    expect(result).toMatchObject({ status: 'unknown', phase: 'readback' }); expect(existsSync(f.paths.lock)).toBe(false);
  });

  it('refuses an unknown object at a vacated stage name during independent readback', { timeout: 120000 }, async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight); let foreign = '';
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => {
      if (event.phase === 'readback' && event.event === 'issued') {
        foreign = join(f.paths.root, event.runId!, 'new-0'); writeFileSync(foreign, 'foreign after close', { mode: 0o600, flag: 'wx' });
      }
    });
    expect(result).toMatchObject({ status: 'unknown', phase: 'readback' }); expect(readFileSync(foreign, 'utf8')).toBe('foreign after close');
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('unknown_stage_appeared');
  });

  it('stops between complete file pairs and permits fresh known-only recovery after writers close', { timeout: 120000 }, async () => {
    const f = fixture(); let probes = 0;
    const changing = (scope: Parameters<typeof preflight>[0], emit: Parameters<typeof preflight>[1]) => ++probes === 5
      ? Promise.resolve({ status: 'stopped' as const } as Awaited<ReturnType<typeof preflightGlobalProcesses>>) : preflight(scope, emit);
    const admission = await bindRegistrationAdmission(f.input, () => {}, changing);
    const result = await executeRegistrationAdmission(admission, admission.planSha256);
    expect(result.status).toBe('unknown');
    expect(await inspectRegistrationJournal(f.home, result.runId!, admission.planSha256)).toMatchObject({ journalStatus: 'ready', executionPermission: false });
    const fresh = await planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight);
    expect((await executeRegistrationRecovery(f.home, result.runId!, admission.planSha256, fresh.evidenceSha256, () => {}, preflight, true)).status).toBe('restored');
  });
  it('refuses a torn journal and a forged native original seed even if the seed is valid JSON', { timeout: 120000 }, async () => {
    const f = fixture(), admission = await bindRegistrationAdmission(f.input, () => {}, preflight);
    const result = await executeRegistrationAdmission(admission, admission.planSha256, event => { if (event.phase === 'retain.0' && event.event === 'completed') throw Error('fixture confirmed stop'); });
    const directory = join(f.paths.root, result.runId!), journal = readFileSync(join(directory, 'journal.jsonl'));
    appendFileSync(join(directory, 'journal.jsonl'), '{');
    expect(await inspectRegistrationJournal(f.home, result.runId!, admission.planSha256)).toMatchObject({ journalStatus: 'torn', currentObjects: 'not-assessed' });
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('pending_torn_or_unknown');
    writeFileSync(join(directory, 'journal.jsonl'), journal);
    const seed = JSON.parse(readFileSync(join(directory, 'seed.json'), 'utf8')); seed.start[0].original.rows[0].identity.ino = '123456789';
    writeFileSync(join(directory, 'seed.json'), JSON.stringify(seed) + '\n');
    await expect(planRegistrationRecovery(f.home, result.runId!, admission.planSha256, () => {}, preflight)).rejects.toThrow('registration_original_or_replacement_changed');
  });
  it('runs the built read-only CLI with real process collection and never exposes fixture data or creates a run', { timeout: 90000 }, () => {
    const f = fixture(), observation = join(f.root, 'observation.json'), proposal = join(f.root, 'proposal.json');
    writeFileSync(observation, JSON.stringify(f.input.source.observation), { mode: 0o600 }); writeFileSync(proposal, JSON.stringify(f.input.source.proposal), { mode: 0o600 });
    const before = readdirSync(f.paths.root), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env.HOME = f.home; env.USERPROFILE = f.home;
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '../dist/caveat.js'), 'deployment', 'registration-plan', '--observation', observation, '--proposal', proposal,
      '--node-version', process.version, '--json'], { env, encoding: 'utf8', timeout: 45000 });
    expect(result.error).toBeUndefined();
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0]).toMatchObject({ phase: 'input', event: 'issued' });
    expect(rows.at(-1)).toMatchObject({ status: 'stopped', filesystemWrites: 0, existingProcessOperations: 0 });
    expect(result.status).toBe(1); expect(result.stdout).not.toContain('fixture-private'); expect(readdirSync(f.paths.root)).toEqual(before);
  });

  it('rejects a proposed binary or library still inside the recorded retired Node root', { timeout: 60000 }, async () => {
    const f = fixture(), before = readdirSync(f.paths.root), retiredNode = join(dirname(dirname(process.execPath)), 'bin', isWindows() ? 'node' : 'node.exe');
    f.input.source.observation.expectedDedicatedNode = retiredNode;
    for (const row of f.input.source.proposal.changes) row.beforeNode = retiredNode;
    await expect(bindRegistrationAdmission(f.input, () => {}, preflight)).rejects.toThrow('still_uses_retired_runtime');
    expect(readdirSync(f.paths.root)).toEqual(before);
  });

});
