import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('関連度が閾値と等しい知見も採用する', async () => {
    const candidates = [{
      hit: { id: 'known-trap', source: 'own', title: '既知の罠', symptomExcerpt: '', environment: {} },
      entry: { sections: { Cause: '原因', Resolution: '対処' } },
    }] as unknown as Parameters<typeof rankKnowledge>[2];
    const selected = await rankKnowledge('dummy', turns(), candidates, async () => ({
      answers: { candidate_0: { type: 'noul', noul: 0.85 } },
    }));
    expect(selected).toBe(candidates[0]);
  });

  it('同じ一回の問い合わせで苦戦と実在する検索語を選ぶ', async () => {
    let calls = 0;
    const result = await judgeStruggle('dummy', turns(), async (_key, state, questions) => {
      calls++;
      expect(state).toEqual({ turns: turns() });
      expect(Object.keys(questions)).toEqual(['repeated_problem', 'clearly_stuck', 'search_term']);
      const options = (questions.search_term as { criteria: Record<string, string> }).criteria;
      expect(Object.values(options)).toContain('PyInstaller');
      const selected = Object.entries(options).find(([, term]) => term === 'PyInstaller')![0];
      return { answers: {
        repeated_problem: { type: 'noul', noul: 0.94 },
        clearly_stuck: { type: 'noul', noul: 0.91 },
        search_term: { type: 'choice', choice: selected, probabilities: {}, confidence: 0.9 },
      } };
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ struggling: true, term: 'PyInstaller' });
    expect(candidateTerms(turns())).toContain('PyInstaller');
    expect(candidateTerms([{ ...turns()[0]!, user: 'PyInstallerで起動失敗する' }])).toContain('PyInstaller');
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
      ask: async () => {
        calls++;
        return { answers: {
          repeated_problem: { type: 'noul' as const, noul: 0.98 },
          clearly_stuck: { type: 'noul' as const, noul: 0.97 },
          search_term: { type: 'choice' as const, choice: 'none', probabilities: { none: 1 }, confidence: 1 },
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
  });
});
