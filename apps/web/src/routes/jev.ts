import { Hono } from 'hono';
import { listJevObservations, type JevObservation } from '@caveat/core';
import type { WebContext } from '../context.js';
import { escapeHtml, layout } from '../layout.js';

const VIEW_FIELDS = [
  'schema', 'id', 'observedAt', 'host', 'sessionId', 'projectRoot', 'transcriptPath', 'turns',
  'thinkingAvailable', 'model', 'repeatedProblem', 'clearlyStuck', 'struggleThreshold',
  'struggling', 'termChoices', 'noneProbability', 'selectedTerms', 'query', 'ftsHits',
  'candidates', 'matchThreshold', 'selectedRef', 'noticeText', 'decision', 'delivery', 'review',
] as const satisfies readonly (keyof JevObservation)[];
const viewIsComplete: Exclude<keyof JevObservation, typeof VIEW_FIELDS[number]> extends never ? true : never = true;
void viewIsComplete;

function percent(numerator: number, denominator: number): string {
  return denominator === 0 ? '—' : `${Math.round(numerator / denominator * 100)}%`;
}

export function createJevRoute(ctx: WebContext): Hono {
  const app = new Hono();
  app.get('/jev', (c) => {
    const cases = listJevObservations(ctx.caveatHome);
    const advice = cases.filter((item) => item.delivery === 'delivered' && item.selectedRef !== null);
    const adviceReviewed = advice.filter((item) => item.review?.verdict === 'correct' || item.review?.verdict === 'incorrect');
    const correct = adviceReviewed.filter((item) => item.review?.verdict === 'correct').length;
    const silentReviewed = cases.filter((item) => item.review?.verdict === 'missed' || item.review?.verdict === 'none');
    const missed = silentReviewed.filter((item) => item.review?.verdict === 'missed').length;
    const rows = cases.slice(0, 100).map((item) => {
      const refs = item.turns.map((turn) => `${turn.originSessionId} #${turn.turnNumber}${turn.truncated ? ' (省略あり)' : ''}`).join(' / ');
      const candidates = item.candidates.map(({ ref, score }) => `${ref} ${score.toFixed(2)}`).join('、') || 'なし';
      return `<tr><td><time>${escapeHtml(item.observedAt)}</time><br><code>${escapeHtml(item.id)}</code></td>
        <td>${escapeHtml(item.host)}<br>${escapeHtml(refs)}</td>
        <td>${item.repeatedProblem.toFixed(2)} / ${item.clearlyStuck.toFixed(2)}<br>語: ${escapeHtml(item.query || 'なし')}</td>
        <td>FTS ${item.ftsHits.length}件<br>${escapeHtml(candidates)}</td>
        <td>${escapeHtml(item.selectedRef ?? 'なし')}<br>${escapeHtml(item.delivery)}</td>
        <td>${escapeHtml(item.review?.verdict ?? '未判定')}</td>
        <td><details><summary>全記録</summary><pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre></details></td></tr>`;
    }).join('');
    const body = `<h2>Jev提案の検証</h2>
      <p>結果の解決状況は集計しません。正誤は元セッションの該当3ターンと知見本文を照合して人が判定します。</p>
      <div class="jev-metrics">
        <div>判定済み3ターン<strong>${cases.length}</strong></div>
        <div>知見を通知<strong>${advice.length}</strong></div>
        <div>通知の正答率<strong>${percent(correct, adviceReviewed.length)}</strong><small>${correct}/${adviceReviewed.length} 件を評価</small></div>
        <div>取りこぼし率<strong>${percent(missed, silentReviewed.length)}</strong><small>${missed}/${silentReviewed.length} 件を評価</small></div>
      </div>
      <p>判定登録: <code>caveat jev review &lt;案件ID&gt; correct|incorrect|missed|none|unclear --note "理由"</code></p>
      <div class="jev-scroll"><table class="jev-cases"><thead><tr><th>日時 / 案件ID</th><th>ホスト / 3ターン</th><th>苦戦スコア / 検索語</th><th>検索候補</th><th>提案 / 配送</th><th>正誤</th><th>詳細</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">記録はまだありません</td></tr>'}</tbody></table></div>
      ${cases.length > 100 ? `<p>最新100件を表示。全${cases.length}件は <code>caveat jev cases --json</code> で確認できます。</p>` : ''}`;
    return c.html(layout('Jev提案の検証 · Caveat', body));
  });
  return app;
}
