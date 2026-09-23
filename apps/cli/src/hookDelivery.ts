import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STOP_REMINDER_PREFIX } from './hookShared.js';

interface DeliveredState { ids: string[]; signals: string[] }

function statePath(caveatHome: string, sessionId: string): string {
  return join(caveatHome, 'hook-delivery', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

function readState(caveatHome: string, sessionId: string): DeliveredState {
  const path = statePath(caveatHome, sessionId);
  if (!existsSync(path)) return { ids: [], signals: [] };
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || !('ids' in value) || !('signals' in value) ||
    !Array.isArray(value.ids) || !value.ids.every((item) => typeof item === 'string') ||
    !Array.isArray(value.signals) || !value.signals.every((item) => typeof item === 'string')) {
    throw new Error('hook_delivery_state_invalid');
  }
  return value as DeliveredState;
}

function writeState(caveatHome: string, sessionId: string, state: DeliveredState): void {
  const path = statePath(caveatHome, sessionId);
  mkdirSync(join(caveatHome, 'hook-delivery'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function wasHitDelivered(caveatHome: string, sessionId: string, ref: string): boolean {
  return readState(caveatHome, sessionId).ids.includes(ref);
}

const SIGNAL_LINES: Array<[RegExp, string, string]> = [
  [/^- tool failure:/u, 'tool_failure', 'ツール失敗'],
  [/^- 同一ファイル複数編集:/u, 'reedit', '同一ファイルの再編集'],
  [/^- WebSearch:/u, 'web_search', 'Web検索'],
  [/^- WebFetch:/u, 'web_fetch', 'Web取得'],
  [/^- 同一 Bash コマンドの再実行:/u, 'bash_retry', '同一コマンドの再実行'],
];

export interface PreparedDelivery { texts: string[]; delivered: () => void }

/** 通知本文を再構成し、未配送の罠IDとシグナル種類だけを残す。 */
export function prepareSessionDelivery(
  caveatHome: string, sessionId: string, contexts: string[],
  additionallyDeliveredIds: string[] = [],
): PreparedDelivery {
  const state = readState(caveatHome, sessionId);
  const seenIds = new Set([...state.ids, ...additionallyDeliveredIds]);
  const seenSignals = new Set(state.signals);
  const addedIds: string[] = [];
  const addedSignals: string[] = [];
  const hitLines: string[] = [];
  const signalLabels: string[] = [];
  const others: string[] = [];
  for (const context of contexts) {
    const text = context.trim();
    if (!text) continue;
    const lines = text.split('\n');
    const isStop = text.startsWith(STOP_REMINDER_PREFIX);
    let hasHit = false;
    for (const line of lines) {
      const hit = /^\d+\. ([^\s]+) \(([^)]+)\) — (.+)$/u.exec(line);
      if (hit) {
        hasHit = true;
        const ref = `${hit[2]}/${hit[1]}`;
        if (seenIds.has(ref)) continue;
        seenIds.add(ref);
        addedIds.push(ref);
        hitLines.push(`${hit[1]} (${hit[2]}) — ${hit[3]}`);
      }
      if (isStop) {
        for (const [pattern, kind, label] of SIGNAL_LINES) {
          if (pattern.test(line) && !seenSignals.has(kind)) {
            seenSignals.add(kind);
            addedSignals.push(kind);
            signalLabels.push(label);
          }
        }
      }
    }
    if (isStop || hasHit) continue;
    if (!others.includes(text)) others.push(text);
  }
  const texts = [...others];
  if (signalLabels.length > 0) texts.push(`[caveat] 新しい苦戦シグナル: ${signalLabels.join('、')}。必要ならCaveatで知見を確認してください。`);
  if (hitLines.length > 0) texts.push(`[caveat] 新しく該当した罠:\n${hitLines.map((line) => `- ${line}`).join('\n')}\n詳細はCaveatで取得し、適用条件を確認してください。`);
  return {
    texts,
    delivered: () => {
      if (addedIds.length === 0 && addedSignals.length === 0 && additionallyDeliveredIds.length === 0) return;
      const latest = readState(caveatHome, sessionId);
      writeState(caveatHome, sessionId, {
        ids: [...new Set([...latest.ids, ...addedIds, ...additionallyDeliveredIds])],
        signals: [...new Set([...latest.signals, ...addedSignals])],
      });
    },
  };
}
