import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listJevObservations, openDb, reviewJevObservation, upsertEntry } from '@caveat/core';
import { candidateTerms, judgeStruggle, rankKnowledge, runJevStruggle, type ThroughlineContext, type ThroughlineTurn } from '../src/jevStruggle.js';
import type { CliContext } from '../src/context.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function turns(): ThroughlineTurn[] {
  return [1, 2, 3].map((turnNumber) => ({
    originSessionId: 'session-1', turnNumber,
    user: 'PyInstaller の起動問題を直して',
    assistant: `PyInstallerの問題はまだ解決していない。試行 ${turnNumber} をやり直す。`,
    thinking: `起動失敗が続く。対処 ${turnNumber} を見直す。`,
    truncated: false,
  }));
}

describe('Jevの苦戦判定', () => {
  it('長いログでも末尾の問題固有語を候補に残す', () => {
    const longPrefix = Array.from({ length: 100 }, (_, index) => 'noise' + index).join(' ');
    const context = turns();
    context[2] = {
      ...context[2]!,
      user: longPrefix + ' cwd=/Users/kite/Developer/Caveat/src/main.ts workerdのWebSocketでRangeError',
      thinking: 'workerdで同じ問題をやり直す',
    };
    const terms = candidateTerms(context);
    expect(terms.length).toBeLessThanOrEqual(48);
    expect(terms).toEqual(expect.arrayContaining(['workerd', 'WebSocket', 'RangeError']));
    expect(terms).not.toContain('Users');
    expect(terms).not.toContain('kite');
  });

  it('関連度が閾値と等しい知見も採用する', async () => {
    const candidates = [{
      hit: { id: 'known-trap', source: 'own', title: '既知の罠', symptomExcerpt: '', environment: {} },
      entry: { sections: { Cause: '原因', Resolution: '対処' } },
    }] as unknown as Parameters<typeof rankKnowledge>[2];
    const selected = await rankKnowledge('dummy', turns(), candidates, async () => ({
      answers: { candidate_0: { type: 'noul', noul: 0.8 } },
    }));
    expect(selected.selected).toBe(candidates[0]);
    expect(selected.scores).toEqual([0.8]);
  });

  it('記録時のOSと適用対象OSをJevに区別して渡す', async () => {
    const candidates = [{
      hit: { id: 'known-trap', source: 'own', title: '既知の罠', symptomExcerpt: '', environment: { os: 'macos' } },
      entry: { sections: { Cause: '原因', Resolution: '対処' } },
    }] as unknown as Parameters<typeof rankKnowledge>[2];
    const selected = await rankKnowledge('dummy', turns(), candidates, async (_key, state, questions) => {
      const candidate = (state as { candidates: Array<{ recordedEnvironment: object; appliesToOs: string | null }> }).candidates[0]!;
      expect(candidate.recordedEnvironment).toEqual({ os: 'macos' });
      expect(candidate.appliesToOs).toBeNull();
      expect(JSON.stringify(questions)).toContain('recordedEnvironment value is where the entry was observed, not a restriction');
      return { answers: { candidate_0: { type: 'noul', noul: 0.89 } } };
    });
    expect(selected.selected).toBe(candidates[0]);
  });

  it('同じ一回の問い合わせで苦戦と最大3つの検索語を選ぶ', async () => {
    let calls = 0;
    const result = await judgeStruggle('dummy', turns(), async (_key, state, questions) => {
      calls++;
      expect(state).toEqual({ turns: turns() });
      expect(Object.keys(questions)).toEqual(['repeated_problem', 'clearly_stuck', 'search_term']);
      const options = (questions.search_term as { criteria: Record<string, string> }).criteria;
      expect(Object.values(options)).toContain('PyInstaller');
      const probabilities = Object.fromEntries(Object.keys(options).map((key) => [key, 0]));
      for (const [term, probability] of [['PyInstaller', 0.45], ['起動失敗', 0.3], ['起動問題', 0.18], ['やり直す', 0.04]] as const) {
        probabilities[Object.entries(options).find(([, value]) => value === term)![0]] = probability;
      }
      probabilities.none = 0.03;
      const selected = Object.entries(options).find(([, term]) => term === 'PyInstaller')![0];
      return { answers: {
        repeated_problem: { type: 'noul', noul: 0.94 },
        clearly_stuck: { type: 'noul', noul: 0.91 },
        search_term: { type: 'choice', choice: selected, probabilities, confidence: 0.9 },
      } };
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ struggling: true, terms: ['PyInstaller', '起動失敗', '起動問題'],
      repeatedProblem: 0.94, clearlyStuck: 0.91, noneProbability: 0.03 });
    expect(candidateTerms(turns())).toContain('PyInstaller');
    expect(candidateTerms([{ ...turns()[0]!, user: 'PyInstallerで起動失敗する' }])).toContain('PyInstaller');
  });

  it('Jevが選んだ3語をAND検索し、共通する知見だけを再判定する', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-jev-and-'));
    roots.push(root);
    const dbPath = join(root, 'index', 'caveat.db');
    const db = openDb({ path: dbPath });
    try {
      for (const [id, title] of [['match', 'RangeError WebSocket workerd'], ['partial', 'RangeError WebSocket']] as const) {
        const frontmatter = { id, title, environment: {}, updated_at: '2026-09-24' };
        upsertEntry(db, {
          id, source: 'own', path: `${id}.md`, title,
          body: `## Symptom\n${title}\n\n## Resolution\n接続処理を修正する。`,
          frontmatter_json: JSON.stringify(frontmatter), tags: '[]', confidence: 'reproduced',
          visibility: 'private', file_mtime: '2026-09-24', indexed_at: '2026-09-24',
        });
      }
    } finally { db.close(); }
    const contextTurns = turns().map((turn) => ({
      ...turn, user: 'workerd WebSocket RangeError', assistant: 'RangeError が続き、やり直す。', thinking: 'WebSocket の修正を再試行する。',
    }));
    const context: ThroughlineContext = { schema: 'throughline.caveat_context.v1', status: 'ready', turns: contextTurns, thinkingAvailable: true };
    let calls = 0;
    const notice = await runJevStruggle({ caveatHome: root, config: { jevEnabled: true }, paths: { dbPath } } as CliContext,
      'claude', { session_id: 'session-and', transcript_path: '/example/session.jsonl', cwd: root }, {
        readContext: () => context,
        readKey: () => 'dummy',
        ask: async (_key, state, questions) => {
          calls++;
          if (calls === 1) {
            const options = (questions.search_term as { criteria: Record<string, string> }).criteria;
            const probabilities = Object.fromEntries(Object.entries(options).map(([key, term]) =>
              [key, ({ RangeError: 0.4, WebSocket: 0.3, workerd: 0.2, none: 0.1 } as Record<string, number>)[term] ?? 0]));
            return { answers: {
              repeated_problem: { type: 'noul', noul: 0.95 }, clearly_stuck: { type: 'noul', noul: 0.94 },
              search_term: { type: 'choice', choice: Object.entries(options).find(([, term]) => term === 'RangeError')![0], probabilities, confidence: 0.6 },
            } };
          }
          expect((state as { candidates: Array<{ title: string }> }).candidates.map((candidate) => candidate.title)).toEqual(['RangeError WebSocket workerd']);
          expect(Object.keys(questions)).toEqual(['candidate_0']);
          return { answers: { candidate_0: { type: 'noul', noul: 0.9 } } };
        },
      });
    expect(calls).toBe(2);
    expect(notice?.text).toContain('own/match');
    let observed = listJevObservations(root);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      host: 'claude', selectedTerms: ['RangeError', 'WebSocket', 'workerd'],
      ftsHits: ['own/match'], candidates: [{ ref: 'own/match', score: 0.9 }],
      selectedRef: 'own/match', decision: 'matched', delivery: 'pending', review: null,
    });
    expect(observed[0]?.noticeText).toContain('接続処理を修正する');
    expect(observed[0]?.turns.map((turn) => turn.turnNumber)).toEqual([1, 2, 3]);
    notice?.delivered();
    observed = listJevObservations(root);
    expect(observed[0]?.delivery).toBe('delivered');
    expect(reviewJevObservation(root, observed[0]!.id, 'correct', '症状と対処が一致').review?.verdict).toBe('correct');
  });

  it('知見候補がなくても一度だけ検索を促し、同じ3ターンでは再送しない', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-jev-test-'));
    roots.push(root);
    const ctx = {
      caveatHome: root,
      config: { jevEnabled: true },
      paths: { dbPath: join(root, 'missing.db') },
    } as CliContext;
    const context: ThroughlineContext = { schema: 'throughline.caveat_context.v1', status: 'ready', turns: turns(), thinkingAvailable: true };
    let calls = 0;
    const deps = {
      readContext: () => context,
      readKey: () => 'dummy',
      ask: async (_key: string, _state: unknown, questions: Record<string, unknown>) => {
        calls++;
        const options = (questions.search_term as { criteria: Record<string, string> }).criteria;
        return { answers: {
          repeated_problem: { type: 'noul' as const, noul: 0.98 },
          clearly_stuck: { type: 'noul' as const, noul: 0.97 },
          search_term: { type: 'choice' as const, choice: 'none', probabilities: Object.fromEntries(Object.keys(options).map((key) => [key, key === 'none' ? 1 : 0])), confidence: 1 },
        } };
      },
    };
    const payload = { session_id: 'session-1', transcript_path: '/example/session.jsonl', cwd: root };
    const notice = await runJevStruggle(ctx, 'claude', payload, deps);
    expect(notice?.text).toContain('Caveatで検索');
    expect((await runJevStruggle(ctx, 'claude', payload, deps))?.text).toContain('Caveatで検索');
    notice?.delivered();
    expect(await runJevStruggle(ctx, 'claude', payload, deps)).toBeNull();
    expect(calls).toBe(2);
    const observed = listJevObservations(root);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ decision: 'no_terms', delivery: 'delivered', selectedRef: null });
    expect(reviewJevObservation(root, observed[0]!.id, 'none').review?.verdict).toBe('none');
  });

  it('苦戦判定で落ちた3ターンも点数と元ターン参照を残す', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caveat-jev-silent-'));
    roots.push(root);
    const context: ThroughlineContext = { schema: 'throughline.caveat_context.v1', status: 'ready', turns: turns(), thinkingAvailable: true };
    const payload = { session_id: 'session-silent', transcript_path: '/example/session.jsonl', cwd: root };
    const ctx = { caveatHome: root, config: { jevEnabled: true }, paths: { dbPath: join(root, 'missing.db') } } as CliContext;
    const notice = await runJevStruggle(ctx, 'codex', payload, {
      readContext: () => context, readKey: () => 'dummy',
      ask: async (_key, _state, questions) => ({ answers: {
        repeated_problem: { type: 'noul', noul: 0.84 }, clearly_stuck: { type: 'noul', noul: 0.92 },
        search_term: { type: 'choice', choice: 'none', confidence: 1,
          probabilities: Object.fromEntries(Object.keys((questions.search_term as { criteria: Record<string, string> }).criteria)
            .map((key) => [key, key === 'none' ? 1 : 0])) },
      } }),
    });
    expect(notice).toBeNull();
    const [item] = listJevObservations(root);
    expect(item).toMatchObject({ host: 'codex', repeatedProblem: 0.84, clearlyStuck: 0.92,
      decision: 'below_struggle_threshold', delivery: 'none', query: '', noticeText: null });
    expect(item?.turns).toHaveLength(3);
    expect(reviewJevObservation(root, item!.id, 'missed', '適切な知見あり').review?.verdict).toBe('missed');
    expect(() => reviewJevObservation(root, item!.id, 'correct')).toThrow('jev_review_verdict_invalid');
  });
});
