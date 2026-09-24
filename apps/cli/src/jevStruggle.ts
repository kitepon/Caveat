import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  environmentAppliesToTask, extractSearchWordCandidates, fingerprint, get, isWindows, markHit, openDb, search,
  type GetResult, type SearchResult,
} from '@caveat/core';
import type { CliContext } from './context.js';
import { readJevKey } from './jevCredential.js';
import { wasHitDelivered } from './hookDelivery.js';

const MODEL = 'jev-1.13.0';
const API_URL = 'https://api.typesafe.ai/v1/systemone';
const STRUGGLE_THRESHOLD = 0.85;
const MATCH_THRESHOLD = 0.8;
const MAX_TERMS = 48;
const MAX_SEARCH_TERMS = 3;
const MAX_CANDIDATES = 20;

export interface ThroughlineTurn {
  originSessionId: string;
  turnNumber: number;
  user: string;
  assistant: string;
  thinking: string;
  truncated: boolean;
}

export interface ThroughlineContext {
  schema: 'throughline.caveat_context.v1';
  status: string;
  turns: ThroughlineTurn[];
  thinkingAvailable: boolean;
}

interface NoulAnswer { type: 'noul'; noul: number }
interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
type Answer = NoulAnswer | ChoiceAnswer;
interface JevResponse { answers: Record<string, Answer> }

interface SessionState {
  lastTurn: string | null;
  deliveredIds: string[];
  notifiedTerms: string[];
}

export interface JevNotice { text: string; ref: string | null; delivered: () => void }

export type JevCall = (key: string, state: unknown, questions: Record<string, unknown>) => Promise<JevResponse>;

export async function callJev(key: string, state: unknown, questions: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<JevResponse> {
  const response = await fetcher(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: MODEL, questions }),
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error(`jev_http_${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.answers)) throw new Error('jev_response_invalid');
  return body as unknown as JevResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function noul(answer: Answer | undefined): number {
  if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error('jev_noul_invalid');
  }
  return answer.noul;
}

function searchTermChoices(answer: Answer | undefined, terms: string[]): string[] {
  if (answer?.type !== 'choice' || !isRecord(answer.probabilities)) throw new Error('jev_choice_invalid');
  const keys = terms.map((_, index) => `term_${index}`);
  const allowed = new Set([...keys, 'none']);
  if (!allowed.has(answer.choice) || Object.keys(answer.probabilities).length !== allowed.size ||
    Object.entries(answer.probabilities).some(([key, probability]) => !allowed.has(key) ||
      typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1)) {
    throw new Error('jev_choice_invalid');
  }
  if (answer.choice === 'none') return [];
  const noneProbability = answer.probabilities.none!;
  return keys.map((key, index) => ({ index, probability: answer.probabilities[key]! }))
    .filter(({ probability }) => probability > noneProbability)
    .sort((a, b) => b.probability - a.probability || a.index - b.index)
    .slice(0, MAX_SEARCH_TERMS)
    .map(({ index }) => terms[index]!);
}

export function candidateTerms(turns: ThroughlineTurn[]): string[] {
  const found = new Map<string, { term: string; turns: Set<number>; last: number }>();
  let position = 0;
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex]!;
    for (const part of [turn.user, turn.thinking, turn.assistant]) {
      for (const term of extractSearchWordCandidates(part)) {
        const key = term.toLocaleLowerCase();
        const item = found.get(key) ?? { term, turns: new Set<number>(), last: 0 };
        item.turns.add(turnIndex);
        item.last = position++;
        found.set(key, item);
      }
    }
  }
  return [...found.values()]
    .sort((a, b) => b.turns.size - a.turns.size || b.last - a.last)
    .slice(0, MAX_TERMS)
    .map((item) => item.term);
}

export async function judgeStruggle(key: string, turns: ThroughlineTurn[], ask: JevCall = callJev): Promise<{ struggling: boolean; terms: string[] }> {
  const terms = candidateTerms(turns);
  const options = Object.fromEntries(terms.map((term, index) => [`term_${index}`, term]));
  const questions: Record<string, unknown> = {
    repeated_problem: { type: 'noul', instructions: 'Across these three ordered turns, is the coding agent repeatedly correcting attempts at the same unresolved task or problem? Judge the meaning of its dialogue and Thinking, not the number of tool calls.' },
    clearly_stuck: { type: 'noul', instructions: 'At the end of turn 3, is the agent clearly struggling with an unresolved problem rather than making a brief, ordinary correction or verification?' },
  };
  if (terms.length > 0) questions.search_term = {
    type: 'choice',
    instructions: 'If the agent is struggling, which exact term from these options would best retrieve a useful Caveat knowledge entry about the concrete unresolved problem? Select none when no option identifies it. The search will use up to three of your highest-ranked terms together as an AND query.',
    criteria: { ...options, none: 'No listed term would retrieve useful knowledge about this problem.' },
  };
  const response = await ask(key, { turns }, questions);
  const struggling = noul(response.answers.repeated_problem) >= STRUGGLE_THRESHOLD &&
    noul(response.answers.clearly_stuck) >= STRUGGLE_THRESHOLD;
  if (!struggling || terms.length === 0) return { struggling, terms: [] };
  return { struggling, terms: searchTermChoices(response.answers.search_term, terms) };
}

interface KnowledgeCandidate { hit: SearchResult; entry: GetResult }

export async function rankKnowledge(key: string, turns: ThroughlineTurn[], candidates: KnowledgeCandidate[], ask: JevCall = callJev): Promise<KnowledgeCandidate | null> {
  if (candidates.length === 0) return null;
  const state = {
    turns,
    currentHostOs: fingerprint().os,
    candidates: candidates.map(({ hit, entry }) => {
      const { applies_to_os: appliesToOs = null, ...recordedEnvironment } = hit.environment;
      return {
        title: hit.title,
        symptom: hit.symptomExcerpt,
        cause: entry.sections.Cause?.slice(0, 300) ?? '',
        resolution: entry.sections.Resolution?.slice(0, 600) ?? '',
        recordedEnvironment,
        appliesToOs,
      };
    }),
  };
  const questions = Object.fromEntries(candidates.map((_, index) => [`candidate_${index}`, {
    type: 'noul',
    instructions: `Does candidates[${index}] directly apply to the unresolved problem shown in the turns and offer a useful resolution? A recordedEnvironment value is where the entry was observed, not a restriction. Only appliesToOs restricts the target OS; null means any OS. currentHostOs may differ from the task's target OS.`,
  }]));
  const response = await ask(key, state, questions);
  let best: KnowledgeCandidate | null = null;
  let bestScore = MATCH_THRESHOLD;
  for (let index = 0; index < candidates.length; index++) {
    const score = noul(response.answers[`candidate_${index}`]);
    if (score >= MATCH_THRESHOLD && (best === null || score > bestScore)) { best = candidates[index]!; bestScore = score; }
  }
  return best;
}

function quotePowerShell(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

export function readThroughlineContext(host: 'claude' | 'codex', sessionId: string, projectRoot: string, transcriptPath: string): ThroughlineContext {
  const sourceId = host === 'codex' && !sessionId.startsWith('codex:') ? `codex:${sessionId}` : sessionId;
  const args = ['caveat-context', '--session', sourceId, '--project', projectRoot, '--host', host, '--transcript', transcriptPath, '--json'];
  const invocation = isWindows()
    ? { command: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`& throughline.cmd ${args.map(quotePowerShell).join(' ')}; exit $LASTEXITCODE`, 'utf16le').toString('base64')] }
    : { command: 'throughline', args };
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', timeout: 1_500, maxBuffer: 128 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('throughline_context_failed');
  const value: unknown = JSON.parse(result.stdout);
  if (!isRecord(value) || value.schema !== 'throughline.caveat_context.v1' || typeof value.status !== 'string' || !Array.isArray(value.turns)) {
    throw new Error('throughline_context_invalid');
  }
  return value as unknown as ThroughlineContext;
}

function statePath(caveatHome: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return join(caveatHome, 'jev-sessions', `${digest}.json`);
}

function loadState(caveatHome: string, sessionId: string): SessionState {
  const path = statePath(caveatHome, sessionId);
  if (!existsSync(path)) return { lastTurn: null, deliveredIds: [], notifiedTerms: [] };
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value) || (value.lastTurn !== null && typeof value.lastTurn !== 'string') ||
    !Array.isArray(value.deliveredIds) || !value.deliveredIds.every((item) => typeof item === 'string') ||
    !Array.isArray(value.notifiedTerms) || !value.notifiedTerms.every((item) => typeof item === 'string')) throw new Error('jev_state_invalid');
  return value as unknown as SessionState;
}

function saveState(caveatHome: string, sessionId: string, state: SessionState): void {
  const path = statePath(caveatHome, sessionId);
  mkdirSync(join(caveatHome, 'jev-sessions'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function reminder(hit: KnowledgeCandidate | null): string {
  if (!hit) return '[caveat] 同じ問題への試行が続き、まだ解決していない可能性があります。必要によりCaveatで検索してみてください。';
  const resolution = hit.entry.sections.Resolution?.replace(/\s+/g, ' ').trim().slice(0, 500) ?? '';
  return `[caveat] 同じ問題への試行が続いています。関連知見: ${hit.hit.title} (${hit.hit.source}/${hit.hit.id})\n対処: ${resolution}\nこの回答で解決しない場合、必要によりCaveatで検索してみてください。`;
}

export async function runJevStruggle(
  ctx: CliContext,
  host: 'claude' | 'codex',
  payload: Record<string, unknown>,
  deps: { readContext?: typeof readThroughlineContext; ask?: JevCall; readKey?: typeof readJevKey } = {},
): Promise<JevNotice | null> {
  if (!ctx.config.jevEnabled) return null;
  const sessionId = payload.session_id ?? payload.sessionId;
  const transcriptPath = payload.transcript_path ?? payload.transcriptPath;
  if (typeof sessionId !== 'string' || !sessionId || typeof transcriptPath !== 'string' || !transcriptPath) {
    throw new Error('jev_hook_context_missing');
  }
  const projectRoot = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const context = (deps.readContext ?? readThroughlineContext)(host, sessionId, projectRoot, transcriptPath);
  if (['unavailable', 'incomplete', 'projection_pending'].includes(context.status)) return null;
  if (context.status !== 'ready' || context.turns.length !== 3) throw new Error(`throughline_context_${context.status}`);
  const latest = context.turns[2]!;
  const turnKey = `${latest.originSessionId}:${latest.turnNumber}`;
  const state = loadState(ctx.caveatHome, sessionId);
  if (state.lastTurn === turnKey) return null;
  const key = (deps.readKey ?? readJevKey)(ctx.caveatHome);
  const ask = deps.ask ?? callJev;
  const judgment = await judgeStruggle(key, context.turns, ask);
  state.lastTurn = turnKey;
  if (!judgment.struggling) { saveState(ctx.caveatHome, sessionId, state); return null; }
  let candidates: KnowledgeCandidate[] = [];
  const query = judgment.terms.join(' ');
  if (query) {
    if (!existsSync(ctx.paths.dbPath)) throw new Error('jev_knowledge_index_missing');
    const db = openDb({ path: ctx.paths.dbPath });
    try {
      const taskText = context.turns.map((turn) => `${turn.user}\n${turn.assistant}\n${turn.thinking}`).join('\n');
      candidates = search(db, { query, limit: MAX_CANDIDATES })
        .filter((hit) => environmentAppliesToTask(hit.environment, taskText, fingerprint().os))
        .map((hit) => ({ hit, entry: get(db, hit.id, hit.source) }))
        .filter((item): item is KnowledgeCandidate => item.entry !== null)
        .filter((item) => Boolean(item.entry.sections.Resolution));
    } finally { db.close(); }
  }
  const selected = await rankKnowledge(key, context.turns, candidates, ask);
  const id = selected ? `${selected.hit.source}/${selected.hit.id}` : null;
  const term = query || '_none';
  if (id && (state.deliveredIds.includes(id) || wasHitDelivered(ctx.caveatHome, sessionId, id)) || !id && state.notifiedTerms.includes(term)) {
    saveState(ctx.caveatHome, sessionId, state);
    return null;
  }
  return {
    text: reminder(selected),
    ref: id,
    delivered: () => {
      const current = loadState(ctx.caveatHome, sessionId);
      current.lastTurn = turnKey;
      if (id && !current.deliveredIds.includes(id)) current.deliveredIds.push(id);
      if (!id && !current.notifiedTerms.includes(term)) current.notifiedTerms.push(term);
      saveState(ctx.caveatHome, sessionId, current);
      if (selected) {
        const db = openDb({ path: ctx.paths.dbPath });
        try { markHit(db, [selected.hit]); } finally { db.close(); }
      }
    },
  };
}
