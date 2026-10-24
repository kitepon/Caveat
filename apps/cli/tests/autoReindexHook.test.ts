import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '@caveat/core';

// Three shipped-bin invocations plus marker polling must fit the test budget.
const HOOK_CHILD_TIMEOUT_MS = 10_000;
const HOOK_E2E_TIMEOUT_MS = 3 * HOOK_CHILD_TIMEOUT_MS + 5_000;

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 3_000;

function entry(): string {
  return `---
id: quasar-junction
title: Quasar junction boot failure
visibility: public
confidence: confirmed
tags: [quasar, junction]
environment: {}
source_project: null
source_session: test
created_at: 2026-07-11
updated_at: 2026-07-11
---

## Symptom
Quasar junction boot failure reports a rare anchor mismatch.
`;
}

function cli(name: string, home: string, env: NodeJS.ProcessEnv = process.env) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    // Exercise the shipped entry point. Repeated tsx loader startup under the
    // full CI load consumed the 5s test budget before these assertions ran.
    [fileURLToPath(new URL('../dist/caveat.js', import.meta.url)), 'hook', name],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      input: JSON.stringify({ session_id: 'auto-reindex', prompt: 'quasar junction boot failure' }),
      encoding: 'utf-8',
      timeout: HOOK_CHILD_TIMEOUT_MS,
      // This file exercises the reindex system in isolation. The autosync
      // worker also reindexes (rewriting the shared .entries-digest marker), so
      // leave it off here or its background write races these marker/mtime
      // assertions. Callers can still override via env.
      env: { CAVEAT_AUTO_SYNC: 'off', ...env, CAVEAT_HOME: home, HOME: join(home, 'user') },
    },
  );
  console.error('[caveat_reindex_fixture]', JSON.stringify({
    step: name, elapsed_ms: Date.now() - started, status: result.status,
    signal: result.signal, error_code: result.error?.code ?? null,
  }));
  return result;
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function fresh(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'caveat-auto-hook-'));
  mkdirSync(join(home, 'own', 'entries'), { recursive: true });
  mkdirSync(join(home, 'user'), { recursive: true });
  mkdirSync(join(home, 'index'), { recursive: true });
  const db = openDb({ path: join(home, 'index', 'caveat.db') });
  db.close();
  writeFileSync(join(home, 'own', 'entries', 'quasar.md'), entry());
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('auto reindex hook', () => {
  it('reindexes directly, writes its marker, and makes the entry surface', { timeout: HOOK_E2E_TIMEOUT_MS }, () => {
    const { home, cleanup } = fresh();
    try {
      const result = cli('reindex', home);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(existsSync(join(home, 'index', '.entries-digest'))).toBe(true);
      const prompt = cli('user-prompt-submit', home);
      expect(prompt.status).toBe(0);
      expect(prompt.stdout).toContain('Quasar junction boot failure');
    } finally { cleanup(); }
  });

  it('spawns from stop only when dirty and leaves a clean marker unchanged', { timeout: HOOK_E2E_TIMEOUT_MS }, async () => {
    const { home, cleanup } = fresh();
    try {
      const stop = cli('stop', home);
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe('');
      const marker = join(home, 'index', '.entries-digest');
      await waitFor(marker);
      const before = statSync(marker).mtimeMs;
      const clean = cli('stop', home);
      expect(clean.status).toBe(0);
      expect(statSync(marker).mtimeMs).toBe(before);
    } finally { cleanup(); }
  });

  it('honors the autosync kill switch and a live lock', { timeout: HOOK_E2E_TIMEOUT_MS }, () => {
    const { home, cleanup } = fresh();
    try {
      const off = cli('reindex', home, { ...process.env, CAVEAT_INDEX_AUTOSYNC: 'off' });
      expect(off.status).toBe(0);
      expect(existsSync(join(home, 'index', '.entries-digest'))).toBe(false);
      writeFileSync(join(home, 'index', '.reindex-lock'), String(process.pid));
      const locked = cli('reindex', home);
      expect(locked.status).toBe(0);
      expect(existsSync(join(home, 'index', '.entries-digest'))).toBe(false);
      rmSync(join(home, 'index', '.reindex-lock'));
      expect(cli('reindex', home).status).toBe(0);
      expect(JSON.parse(readFileSync(join(home, 'index', '.entries-digest'), 'utf-8')).fileCount).toBe(1);
    } finally { cleanup(); }
  });
});
