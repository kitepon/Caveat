import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ failure: undefined as unknown, cleanup: undefined as unknown, paths: [] as string[], closed: 0 }));
vi.mock('node:sqlite', async (original) => {
  const actual = await original<typeof import('node:sqlite')>();
  return { ...actual, DatabaseSync: function (...args: ConstructorParameters<typeof actual.DatabaseSync>) {
    state.paths.push(String(args[0]));
    const db = new actual.DatabaseSync(...args);
    const exec = db.exec.bind(db), close = db.close.bind(db);
    db.exec = (sql: string) => {
      if (sql.includes('CREATE VIRTUAL TABLE caveat_runtime_fts') && state.failure !== undefined) throw state.failure;
      return exec(sql);
    };
    db.close = () => { close(); state.closed++; if (state.cleanup !== undefined) throw state.cleanup; };
    return db;
  } };
});
import { assertSqliteSearchCapability, UnsupportedSqliteRuntimeError } from '../src/runtimeCapabilities.js';
import { openDb } from '../src/db.js';
import { activateManagedDeployment, preflightManagedDeployment, stageManagedDeployment } from '../src/managedDeployment.js';

const roots: string[] = [];
function root() { const p = mkdtempSync(join(tmpdir(), 'caveat-runtime-capability-')); roots.push(p); return p; }
function missing(message = 'no such module: fts5') { return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR' }); }
beforeEach(() => { state.failure = undefined; state.cleanup = undefined; state.paths = []; state.closed = 0; });
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true }); });

describe('runtime SQLite search capability', () => {
  it('actually creates, inserts and searches with the trigram tokenizer in memory', () => {
    expect(assertSqliteSearchCapability()).toMatchObject({ node: process.version, fts5Trigram: true });
    expect(state.paths).toEqual([':memory:']);
    expect(state.closed).toBe(1);
  });

  it.each(['no such module: fts5', 'no such tokenizer: trigram'])('rejects %s before creating the index parent', (message) => {
    const source = missing(message), parent = join(root(), 'not-created');
    state.failure = source;
    let caught: unknown;
    try { openDb({ path: join(parent, 'index.db') }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(UnsupportedSqliteRuntimeError);
    expect(caught).toMatchObject({ code: 'CAVEAT_RUNTIME_UNSUPPORTED', capability: 'sqlite_fts5_trigram', cause: source });
    expect((caught as Error).message).toContain(message);
    expect(existsSync(parent)).toBe(false);
    expect(state.paths).toEqual([':memory:']);
    expect(state.closed).toBe(1);
  });

  it('leaves an existing index and journal bytes unchanged on refusal', async () => {
    const { DatabaseSync } = await vi.importActual<typeof import('node:sqlite')>('node:sqlite');
    const file = join(root(), 'index.db'), db = new DatabaseSync(file);
    db.exec('CREATE TABLE retained(value); INSERT INTO retained VALUES (42); PRAGMA user_version=2');
    db.close();
    const before = readFileSync(file);
    state.failure = missing();
    expect(() => openDb({ path: file })).toThrow(UnsupportedSqliteRuntimeError);
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);
    expect(state.paths).toEqual([':memory:']);
  });

  it('does not convert unknown or resource failures into supported-runtime refusal', () => {
    const original = Object.assign(new Error('out of memory'), { code: 'ERR_SQLITE_ERROR' });
    state.failure = original;
    expect(() => assertSqliteSearchCapability()).toThrow(original);
    try { assertSqliteSearchCapability(); } catch (error) { expect(error).toBe(original); }
  });

  it('retains primary cause and a separate cleanup failure', () => {
    const original = missing(), cleanup = new Error('probe close failed');
    state.failure = original; state.cleanup = cleanup;
    let caught: unknown;
    try { assertSqliteSearchCapability(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors[0]).toBeInstanceOf(UnsupportedSqliteRuntimeError);
    expect(aggregate.errors[0].cause).toBe(original);
    expect(aggregate.errors[1]).toBe(cleanup);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.message).toContain('no such module: fts5');
    expect(aggregate.message).toContain('probe close failed');
  });

  it('propagates a cleanup-only failure', () => {
    const cleanup = new Error('probe close failed'); state.cleanup = cleanup;
    try { assertSqliteSearchCapability(); expect.unreachable(); } catch (error) { expect(error).toBe(cleanup); }
  });

  it('rejects preflight, stage and activate before any installer source/root operation', () => {
    const home = join(root(), 'absent-home'); state.failure = missing();
    const options = { userHome: home };
    for (const run of [() => preflightManagedDeployment('absent-package', options), () => stageManagedDeployment('absent-package', options), () => activateManagedDeployment('absent-release', options)]) {
      expect(run).toThrow(UnsupportedSqliteRuntimeError);
      expect(existsSync(home)).toBe(false);
    }
    expect(state.paths).toEqual([':memory:', ':memory:', ':memory:']);
  });
});
