import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { markHit } from '../src/markHit.js';

async function holdWriter(path: string): Promise<ChildProcess> {
  const worker = fork(new URL('./fixtures/db-writer.mjs', import.meta.url), [path], {
    execArgv: ['--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  await Promise.race([
    once(worker, 'message'),
    once(worker, 'exit').then(() => { throw new Error('writer exited before acquiring lock'); }),
  ]);
  return worker;
}

describe('concurrent index writers', () => {
  it('waits for a brief writer lock before recording a search hit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caveat-db-contention-'));
    const path = join(dir, 'index.db');
    let writer: ChildProcess | undefined;
    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb({ path });
      db.prepare(`INSERT INTO entries (id,source,path,title,body,frontmatter_json,file_mtime,indexed_at,topical_text,symptom_text)
        VALUES ('fixture','own','fixture.md','SQLite fixture','body','{}','m','i','SQLite fixture','body')`).run();
      db.close(); db = undefined;
      writer = await holdWriter(path);
      writer.send({ releaseAfterMs: 150 });
      db = openDb({ path });
      markHit(db, [{ id: 'fixture', source: 'own' }], () => '2026-10-06T05:46:49.595Z');
      expect(db.prepare('SELECT last_hit_at FROM entries').get()?.last_hit_at)
        .toBe('2026-10-06T05:46:49.595Z');
    } finally {
      db?.close();
      writer?.kill();
      if (writer && writer.exitCode === null) await once(writer, 'exit');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still fails within a bounded wait when the writer does not release its lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caveat-db-contention-'));
    const path = join(dir, 'index.db');
    let writer: ChildProcess | undefined;
    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb({ path });
      db.prepare(`INSERT INTO entries (id,source,path,title,body,frontmatter_json,file_mtime,indexed_at,topical_text,symptom_text)
        VALUES ('fixture','own','fixture.md','SQLite fixture','body','{}','m','i','SQLite fixture','body')`).run();
      db.close(); db = undefined;
      writer = await holdWriter(path);
      writer.send({ releaseAfterMs: 3000 });
      db = openDb({ path });
      expect(() => markHit(db!, [{ id: 'fixture', source: 'own' }])).toThrow('database is locked');
      expect(db.prepare('SELECT last_hit_at FROM entries').get()?.last_hit_at).toBeNull();
    } finally {
      db?.close();
      writer?.kill();
      if (writer && writer.exitCode === null) await once(writer, 'exit');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
