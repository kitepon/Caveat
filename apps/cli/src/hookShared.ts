import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  acknowledgePendingReminders,
  buildAndPublishPendingReminder,
  buildPendingSemanticKey,
  defaultSelfIdentityTokens,
  drainPendingRemindersDetailed,
  environmentAppliesToTask,
  peekPendingRemindersDetailed,
  fingerprint,
  findCaveatsForHook,
  findCaveatsForHookSegments,
  logHookQueryMiss,
  markHit,
  openDb,
  observeRuntimeError,
  type Logger,
  type HookSearchInput,
  type SearchResult,
  type SessionSignals,
} from '@caveat/core';
import { buildContext, type CliContext } from './context.js';
import { CAVEAT_VERSION } from './version.js';

/**
 * Claude / Codex / Cursor の hook コマンドで共有するベンダー中立エンジン。
 * ホスト差分(出力形式・payload 解釈・reminder 本文の組み立て)は
 * hookCmd.ts / codexHookCmd.ts / cursorHookCmd.ts 側に残し、DB 検索・pending queue・
 * stop 重複抑止・stdin 処理はこの 1 実装だけを使う。
 */
export interface HookHost {
  agent: 'claude' | 'codex' | 'cursor';
  /** stderr 診断行の prefix(例: 'caveat:hook')。 */
  stderrTag: string;
  errorCode: 'CAVEAT.CLAUDE_HOOK_FAILED' | 'CAVEAT.CODEX_HOOK_FAILED' | 'CAVEAT.CURSOR_HOOK_FAILED';
  /** `<caveatHome>/<dir>/<sessionId>.txt` に stop 重複抑止キーを置く。 */
  stopStateDir: string;
  /** compact 時に stop reminder 同士を 1 件へ寄せる dedupe キー。 */
  stopDedupeKey: string;
}

const MAX_CONTEXT_BLOCKS = 3;
export const STOP_REMINDER_PREFIX =
  '[caveat] このセッションで外部仕様の罠に当たった可能性を示すシグナル:';

export function hookSilentLogger(host: HookHost): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: (m) => process.stderr.write(`[${host.stderrTag}] ${m}\n`),
  };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportHookError(host: HookHost, phase: string, err: unknown): void {
  observeRuntimeError(host.errorCode, { version: CAVEAT_VERSION });
  process.stderr.write(`[${host.stderrTag}] ${phase}: ${errorMessage(err)}\n`);
}

export function parsePayload(host: HookHost, raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    reportHookError(host, 'json parse error', err);
    return {};
  }
}

export function buildContextSafely(host: HookHost): CliContext | null {
  try {
    return buildContext(hookSilentLogger(host));
  } catch (err: unknown) {
    reportHookError(host, 'context error', err);
    return null;
  }
}

export function searchCaveatsSafely(
  host: HookHost,
  input: HookSearchInput | readonly HookSearchInput[],
): SearchResult[] {
  const inputs: readonly HookSearchInput[] = Array.isArray(input) ? input : [input as HookSearchInput];
  const queryForLog = inputs.map((item) => item.surface === 'user_prompt'
    ? (item.topicText || item.failureText)
    : item.failureText).filter(Boolean).join('\n');
  if (inputs.length === 0 || inputs.every((item) => !item.topicText && !item.failureText)) return [];
  let db: DatabaseSync | undefined;
  let caveatHome: string | undefined;
  let hits: SearchResult[];
  try {
    const ctx = buildContextSafely(host);
    if (!ctx || !existsSync(ctx.paths.dbPath)) return [];
    caveatHome = ctx.caveatHome;
    db = openDb({ path: ctx.paths.dbPath });
    const searchOptions = {
      selfIdentity: defaultSelfIdentityTokens(),
    };
    const found = inputs.length === 1
      ? findCaveatsForHook(db, inputs[0]!, searchOptions)
      : findCaveatsForHookSegments(db, inputs, searchOptions);
    const taskText = inputs.map(({ topicText, failureText }) => `${topicText}\n${failureText}`).join('\n');
    hits = found.filter((hit) => environmentAppliesToTask(hit.environment, taskText, fingerprint().os));
  } catch (err: unknown) {
    reportHookError(host, 'search error', err);
    return [];
  }
  if (hits.length > 0) {
    try {
      markHit(db!, hits);
    } catch (err: unknown) {
      reportHookError(host, 'markHit error', err);
    }
  } else {
    try {
      logHookQueryMiss({ caveatHome: caveatHome!, agent: host.agent, surface: inputs[0]!.surface, query: queryForLog });
    } catch (err: unknown) {
      reportHookError(host, 'query log error', err);
    }
  }
  try {
    return hits;
  } finally {
    db?.close();
  }
}

export function pendingCleanupFailureText(host: HookHost): string {
  return `[${host.stderrTag}] pending reminder cleanup failed`;
}

export function drainForSession(host: HookHost, sessionId: string): string[] {
  const ctx = buildContextSafely(host);
  if (!ctx) return [];
  const local = drainPendingRemindersDetailed(ctx.caveatHome, sessionId);
  const global = drainPendingRemindersDetailed(ctx.caveatHome, '_global');
  for (const _failure of [...local.cleanupFailures, ...global.cleanupFailures]) {
    process.stderr.write(`${pendingCleanupFailureText(host)}\n`);
  }
  return [...local.reminders, ...global.reminders];
}

export interface PeekedSessionReminders { contexts: string[]; paths: string[]; caveatHome: string | null }

export function peekForSession(host: HookHost, sessionId: string, discardSession = false): PeekedSessionReminders {
  const ctx = buildContextSafely(host);
  if (!ctx) return { contexts: [], paths: [], caveatHome: null };
  const local = peekPendingRemindersDetailed(ctx.caveatHome, sessionId);
  const global = peekPendingRemindersDetailed(ctx.caveatHome, '_global');
  for (const _failure of [...local.readFailures, ...global.readFailures]) {
    process.stderr.write(`${pendingCleanupFailureText(host)}\n`);
  }
  if (discardSession) {
    try { acknowledgePendingReminders(ctx.caveatHome, local.reminders.map(({ path }) => path)); }
    catch (error: unknown) { process.stderr.write(`[${host.stderrTag}] pending reminder cleanup failed: ${errorMessage(error)}\n`); }
  }
  const reminders = discardSession ? global.reminders : [...local.reminders, ...global.reminders];
  return { contexts: reminders.map(({ text }) => text), paths: reminders.map(({ path }) => path), caveatHome: ctx.caveatHome };
}

export function acknowledgeSessionReminders(host: HookHost, peeked: PeekedSessionReminders): void {
  if (!peeked.caveatHome || peeked.paths.length === 0) return;
  try { acknowledgePendingReminders(peeked.caveatHome, peeked.paths); }
  catch (error: unknown) { process.stderr.write(`[${host.stderrTag}] pending reminder cleanup failed: ${errorMessage(error)}\n`); }
}

export async function emitHookContext(host: HookHost, output: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => process.stdout.write(output,
      (error) => error ? reject(error) : resolve()));
    return true;
  } catch (error: unknown) {
    process.stderr.write(`[${host.stderrTag}] stdout write failed: ${errorMessage(error)}\n`);
    return false;
  }
}

function contextDedupeKey(host: HookHost, text: string): string {
  if (text.startsWith(STOP_REMINDER_PREFIX)) return host.stopDedupeKey;
  return text.trim();
}

export function compactContexts(host: HookHost, contexts: string[]): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (let i = contexts.length - 1; i >= 0; i -= 1) {
    const text = contexts[i]?.trim();
    if (!text) continue;
    const key = contextDedupeKey(host, text);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(text);
  }
  selected.reverse();
  const limited = selected.slice(-MAX_CONTEXT_BLOCKS);
  const omitted = selected.length - limited.length;
  if (omitted > 0) {
    limited.push(
      `[caveat] pending reminder ${omitted} 件を重複または上限により省略しました。`,
    );
  }
  return limited;
}

function sanitizeStateId(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.length > 0 ? clean : '_unknown';
}

export function stopSignalKey(signals: SessionSignals, related: SearchResult[]): string {
  const body = JSON.stringify({
    signalKinds: [
      signals.toolFailureCount > 0 && 'tool_failure',
      signals.fileEditCounts.length > 0 && 'reedit',
      signals.webSearchCount > 0 && 'web_search',
      signals.webFetchCount > 0 && 'web_fetch',
      signals.bashRetryCount > 0 && 'bash_retry',
    ].filter(Boolean),
    related: related.map((h) => [h.source, h.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return createHash('sha256').update(body).digest('hex');
}

function stopStatePath(host: HookHost, caveatHome: string, sessionId: string): string {
  return join(caveatHome, host.stopStateDir, `${sanitizeStateId(sessionId)}.txt`);
}

function wasStopReminderQueued(host: HookHost, caveatHome: string, sessionId: string, key: string): boolean {
  const path = stopStatePath(host, caveatHome, sessionId);
  try {
    return readFileSync(path, 'utf-8') === key;
  } catch {
    return false;
  }
}

function markStopReminderQueued(host: HookHost, caveatHome: string, sessionId: string, key: string): void {
  const path = stopStatePath(host, caveatHome, sessionId);
  mkdirSync(join(caveatHome, host.stopStateDir), { recursive: true });
  writeFileSync(path, key, 'utf-8');
}

export function queueStopForSession(
  host: HookHost,
  sessionId: string,
  signals: SessionSignals,
  related: SearchResult[],
  buildText: () => string,
): void {
  const ctx = buildContextSafely(host);
  if (!ctx) return;
  const key = stopSignalKey(signals, related);
  if (wasStopReminderQueued(host, ctx.caveatHome, sessionId, key)) return;
  let result: ReturnType<typeof buildAndPublishPendingReminder>;
  try {
    result = buildAndPublishPendingReminder(ctx.caveatHome, sessionId, buildPendingSemanticKey({
      agent: host.agent, surface: 'stop', refs: related, stopSignalDigest: key,
    }), buildText);
  } catch {
    process.stderr.write(`[${host.stderrTag}] pending reminder build or publish failed\n`);
    return;
  }
  if (!result.ran) return;
  try {
    markStopReminderQueued(host, ctx.caveatHome, sessionId, key);
  } catch (err: unknown) {
    process.stderr.write(`[${host.stderrTag}] pending reminder write error: ${errorMessage(err)}\n`);
  }
}

/**
 * PostToolUse `tool_response` からテキスト部分を取り出す。Claude Code /
 * Codex とも string・content/output オブジェクト・content block 配列の
 * いずれかを渡してくる。未知の形は空文字。
 */
export function extractToolResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    return response
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item !== null && typeof item === 'object') {
          const text = (item as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (response !== null && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (typeof r.content === 'string') return r.content;
    if (Array.isArray(r.content)) return extractToolResponseText(r.content);
    if (typeof r.output === 'string') return r.output;
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      return [r.stdout, r.stderr].filter((x) => typeof x === 'string').join(' ');
    }
  }
  return '';
}
