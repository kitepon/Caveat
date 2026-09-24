import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const JEV_OBSERVATION_SCHEMA = 'caveat.jev_observation.v1';
export type JevReviewVerdict = 'correct' | 'incorrect' | 'missed' | 'none' | 'unclear';
export interface JevObservation {
  schema: typeof JEV_OBSERVATION_SCHEMA;
  id: string;
  observedAt: string;
  host: 'claude' | 'codex';
  sessionId: string;
  projectRoot: string;
  transcriptPath: string;
  turns: Array<{ originSessionId: string; turnNumber: number; truncated: boolean }>;
  thinkingAvailable: boolean;
  model: string;
  repeatedProblem: number;
  clearlyStuck: number;
  struggleThreshold: number;
  struggling: boolean;
  termChoices: Array<{ term: string; probability: number }>;
  noneProbability: number | null;
  selectedTerms: string[];
  query: string;
  ftsHits: string[];
  candidates: Array<{ ref: string; score: number }>;
  matchThreshold: number;
  selectedRef: string | null;
  noticeText: string | null;
  decision: 'below_struggle_threshold' | 'no_terms' | 'no_candidates' | 'below_match_threshold' | 'matched';
  delivery: 'none' | 'pending' | 'delivered' | 'suppressed';
  review: { verdict: JevReviewVerdict; note: string; reviewedAt: string } | null;
}

const directory = (home: string) => join(home, 'jev-observations');
const pathFor = (home: string, id: string) => {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('jev_observation_id_invalid');
  return join(directory(home), `${id}.json`);
};

export function jevObservationId(host: JevObservation['host'], sessionId: string, turnKey: string): string {
  return createHash('sha256').update(`${host}\0${sessionId}\0${turnKey}`).digest('hex');
}

function validate(value: unknown): asserts value is JevObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('jev_observation_invalid');
  const item = value as JevObservation;
  if (item.schema !== JEV_OBSERVATION_SCHEMA || typeof item.id !== 'string' || !/^[0-9a-f]{64}$/.test(item.id) ||
    !['claude', 'codex'].includes(item.host) || typeof item.observedAt !== 'string' ||
    typeof item.sessionId !== 'string' || typeof item.projectRoot !== 'string' || typeof item.transcriptPath !== 'string' ||
    !Array.isArray(item.turns) || item.turns.some((turn) => typeof turn.originSessionId !== 'string' ||
      !Number.isSafeInteger(turn.turnNumber) || typeof turn.truncated !== 'boolean') ||
    typeof item.thinkingAvailable !== 'boolean' || typeof item.model !== 'string' ||
    ![item.repeatedProblem, item.clearlyStuck, item.struggleThreshold, item.matchThreshold]
      .every((score) => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) ||
    typeof item.struggling !== 'boolean' || !Array.isArray(item.termChoices) ||
    item.termChoices.some((choice) => typeof choice.term !== 'string' || typeof choice.probability !== 'number') ||
    (item.noneProbability !== null && typeof item.noneProbability !== 'number') ||
    !Array.isArray(item.selectedTerms) || item.selectedTerms.some((term) => typeof term !== 'string') ||
    typeof item.query !== 'string' || !Array.isArray(item.ftsHits) || item.ftsHits.some((ref) => typeof ref !== 'string') ||
    !Array.isArray(item.candidates) || item.candidates.some((candidate) => typeof candidate.ref !== 'string' ||
      typeof candidate.score !== 'number' || !Number.isFinite(candidate.score)) ||
    (item.selectedRef !== null && typeof item.selectedRef !== 'string') ||
    (item.noticeText !== null && typeof item.noticeText !== 'string') ||
    !['below_struggle_threshold', 'no_terms', 'no_candidates', 'below_match_threshold', 'matched'].includes(item.decision) ||
    !['none', 'pending', 'delivered', 'suppressed'].includes(item.delivery) ||
    (item.review !== null && (!item.review || typeof item.review !== 'object' ||
      !['correct', 'incorrect', 'missed', 'none', 'unclear'].includes(item.review.verdict) ||
      typeof item.review.note !== 'string' || typeof item.review.reviewedAt !== 'string'))) throw new Error('jev_observation_invalid');
}

export function readJevObservation(home: string, id: string): JevObservation {
  const value: unknown = JSON.parse(readFileSync(pathFor(home, id), 'utf8'));
  validate(value);
  if (value.id !== id) throw new Error('jev_observation_id_mismatch');
  return value;
}

export function listJevObservations(home: string): JevObservation[] {
  const dir = directory(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
    .map((name) => readJevObservation(home, name.slice(0, -5)))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id));
}

export function writeJevObservation(home: string, item: JevObservation): void {
  validate(item);
  const dir = directory(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = pathFor(home, item.id);
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function updateJevDelivery(home: string, id: string): void {
  const item = readJevObservation(home, id);
  if (item.delivery !== 'pending') throw new Error('jev_observation_not_pending');
  writeJevObservation(home, { ...item, delivery: 'delivered' });
}

export function reviewJevObservation(home: string, id: string, verdict: JevReviewVerdict, note = ''): JevObservation {
  const item = readJevObservation(home, id);
  const adviceDelivered = item.delivery === 'delivered' && item.selectedRef !== null;
  if (item.delivery === 'pending' || item.delivery === 'suppressed' ||
    (adviceDelivered && !['correct', 'incorrect', 'unclear'].includes(verdict)) ||
    (!adviceDelivered && !['missed', 'none', 'unclear'].includes(verdict))) throw new Error('jev_review_verdict_invalid');
  const updated = { ...item, review: { verdict, note, reviewedAt: new Date().toISOString() } };
  writeJevObservation(home, updated);
  return updated;
}
