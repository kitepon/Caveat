import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSessionDelivery } from '../src/hookDelivery.js';
import { stopSignalKey } from '../src/hookShared.js';
import type { SearchResult, SessionSignals } from '@caveat/core';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'caveat-delivery-')); roots.push(path); return path; };

describe('セッション通知', () => {
  it('配送前は消さず、配送後はid単位で再掲しない', () => {
    const home = root();
    const first = '[caveat] 直前のエラーに一致する可能性のある既知の罠が 1 件あります:\n1. trap-a (own) — 罠A\n   症状: 失敗';
    const next = '[caveat] このプロンプトに関連する可能性のある既知の罠が 2 件あります:\n1. trap-a (own) — 罠A\n2. trap-b (own) — 罠B';
    const before = prepareSessionDelivery(home, 'session', [first]);
    expect(before.texts.join('\n')).toContain('trap-a');
    expect(prepareSessionDelivery(home, 'session', [first]).texts.join('\n')).toContain('trap-a');
    before.delivered();
    const newOnly = prepareSessionDelivery(home, 'session', [next]);
    expect(newOnly.texts.join('\n')).not.toContain('trap-a');
    expect(newOnly.texts.join('\n')).toContain('trap-b');
    newOnly.delivered();
    expect(prepareSessionDelivery(home, 'session', [next]).texts).toEqual([]);
  });

  it('件数と経過時間の増加を再送せず、新種のシグナルを送る', () => {
    const home = root();
    const stop = (failure: number, search: number, minutes: number) =>
      `[caveat] このセッションで外部仕様の罠に当たった可能性を示すシグナル:\n- tool failure: ${failure} 件\n${search ? `- WebSearch: ${search} 回\n` : ''}- 経過時間: ${minutes} 分`;
    const first = prepareSessionDelivery(home, 'session', [stop(1, 0, 3)]);
    first.delivered();
    expect(prepareSessionDelivery(home, 'session', [stop(4, 0, 20)]).texts).toEqual([]);
    const changed = prepareSessionDelivery(home, 'session', [stop(5, 2, 25)]);
    expect(changed.texts.join('\n')).toContain('Web検索');
    expect(changed.texts.join('\n')).not.toContain('ツール失敗');
  });

  it('Stopのdedupe keyは件数を無視し、共起した罠で変わる', () => {
    const signals = (count: number): SessionSignals => ({ toolFailureCount: count, fileEditCounts: [], webSearchCount: 0,
      webFetchCount: 0, bashRetryCount: 0, durationMinutes: count, errorSnippets: [], searchQueries: [] });
    const hit = { source: 'own', id: 'new-trap' } as SearchResult;
    expect(stopSignalKey(signals(1), [])).toBe(stopSignalKey(signals(5), []));
    expect(stopSignalKey(signals(1), [])).not.toBe(stopSignalKey(signals(5), [hit]));
  });
});
