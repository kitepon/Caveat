import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import {
  CAVEAT_AUTO_SYNC_ENV,
  hasAnyStruggleSignal,
  isPrivateOwnerStat,
  openDb,
  acquireReindexLock,
  computeEntriesDigest,
  createKeyserverKeyProvider,
  reindexAllSources,
  releaseReindexLock,
  prewarmSealedKeys,
  writeDigestMarker,
  readSessionSignals,
  runAutoSync,
  stopReminderText,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  buildAndPublishPendingReminder,
  buildPendingSemanticKey,
  maybeSweepPendingDirs,
  type SearchResult,
  type SessionSignals,
} from '@caveat/core';
import { maybeTriggerAutoReindex } from '../autoReindexTrigger.js';
import { maybeTriggerAutoSync } from '../autoSyncTrigger.js';
import { runJevStruggle, type JevNotice } from '../jevStruggle.js';
import { prepareSessionDelivery } from '../hookDelivery.js';
import {
  acknowledgeSessionReminders,
  buildContextSafely,
  emitHookContext,
  errorMessage,
  extractToolResponseText,
  hookSilentLogger,
  parsePayload,
  peekForSession,
  pendingCleanupFailureText,
  queueStopForSession,
  readStdin,
  searchCaveatsSafely,
  type HookHost,
} from '../hookShared.js';

export type HookName = 'user-prompt-submit' | 'post-tool-use' | 'stop' | 'worker' | 'reindex' | 'autosync';

const CLAUDE_HOST: HookHost = {
  agent: 'claude',
  stderrTag: 'caveat:hook',
  errorCode: 'CAVEAT.CLAUDE_HOOK_FAILED',
  stopStateDir: 'claude-stop-state',
  stopDedupeKey: 'claude-stop-reminder',
};

const silentLogger = hookSilentLogger(CLAUDE_HOST);

function getSessionId(payload: Record<string, unknown>): string {
  const v = payload.session_id ?? payload.sessionId;
  return typeof v === 'string' && v.length > 0 ? v : '_unknown';
}

function loadSignalsSafely(path: string): SessionSignals | null {
  try {
    return readSessionSignals(path);
  } catch (err: unknown) {
    process.stderr.write(`[caveat:hook] transcript read error: ${errorMessage(err)}\n`);
    return null;
  }
}

function systemReminderOutput(text: string): string {
  return `<system-reminder>${text.replace(/</g, '‹').replace(/>/g, '›')}</system-reminder>`;
}

export function claudePendingCleanupFailureText(): string {
  return pendingCleanupFailureText(CLAUDE_HOST);
}

function toolTopicText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const toolName = payload.tool_name ?? payload.toolName;
  if (typeof toolName === 'string') parts.push(toolName);
  const input = payload.tool_input ?? payload.toolInput;
  if (typeof input === 'string') parts.push(input);
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'query', 'url']) {
      if (typeof record[key] === 'string') parts.push(record[key]);
    }
  }
  return parts.join('\n');
}

function isToolError(payload: Record<string, unknown>): boolean {
  if (payload.hook_event_name === 'PostToolUseFailure') return true;
  const resp = payload.tool_response ?? (payload as Record<string, unknown>).toolResponse;
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    if ((resp as Record<string, unknown>).is_error === true) return true;
  }
  // Some transcripts surface the flag at top level
  if (payload.is_error === true) return true;
  if (typeof payload.error === 'string' && payload.error.length > 0) return true;
  return false;
}

interface WorkerJob {
  schemaVersion: 'caveat-worker-job/v2';
  sessionId: string;
  topicText: string;
  failureText: string;
}

const WORKER_STALE_MS = 24 * 60 * 60 * 1000;
const WORKER_ROOT = 'caveat-worker-v1';
const WORKER_MARKER = '.caveat-worker-schema-v1';

function spawnWorker(job: Omit<WorkerJob, 'schemaVersion'>): void {
  let root: string | undefined;
  let workDir: string | undefined;
  let workFile: string | undefined;
  try {
    root = workerRoot();
    sweepStaleWorkerDirs(Date.now(), root);
    workDir = mkdtempSync(join(root, 'job-'));
    chmodSync(workDir, 0o700);
    workFile = join(workDir, `${randomBytes(4).toString('hex')}.json`);
    writeFileSync(workFile, JSON.stringify({ ...job, schemaVersion: 'caveat-worker-job/v2' }), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (err: unknown) {
    process.stderr.write(`[caveat:hook] worker writefile error: ${errorMessage(err)}\n`);
    cleanupWorkerDir(workDir, workDir ? dirname(workDir) : undefined);
    return;
  }
  // process.argv[1] is the CLI script path (dist/caveat.js bootstrap).
  // Detached + ignored stdio so parent exits immediately and the worker
  // outlives it without blocking Claude Code.
  const cliScript = process.argv[1];
  if (!cliScript) {
    cleanupWorkerDir(workDir, root);
    return;
  }
  try {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', cliScript, 'hook', 'worker', workFile!],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch (err: unknown) {
    process.stderr.write(`[caveat:hook] worker spawn error: ${errorMessage(err)}\n`);
    try {
      cleanupWorkerDir(workDir, root);
    } catch {
      // ignore
    }
  }
}

async function runWorker(workFile: string): Promise<void> {
  // Worker runs detached — stdout/stderr go nowhere. Silent failures are OK;
  // the main hook process never waits on us.
  let raw: string;
  try {
    raw = readFileSync(workFile, 'utf-8');
  } catch {
    process.exit(0);
  }
  cleanupWorkerDir(dirname(workFile), dirname(dirname(workFile)));
  let job: WorkerJob;
  try {
    job = JSON.parse(raw) as WorkerJob;
  } catch {
    process.exit(0);
  }
  if (!job.failureText || !job.sessionId) process.exit(0);

  const hits = searchCaveatsSafely(CLAUDE_HOST, {
    topicText: job.topicText,
    failureText: job.failureText,
    surface: 'tool_error',
  });
  if (hits.length === 0) process.exit(0);

  const ctx = buildContextSafely(CLAUDE_HOST);
  if (!ctx) process.exit(0);
  let result: ReturnType<typeof buildAndPublishPendingReminder>;
  try {
    result = buildAndPublishPendingReminder(ctx.caveatHome, job.sessionId, buildPendingSemanticKey({
      agent: 'claude', surface: 'tool_error', refs: hits,
    }), () => toolErrorReminderText(hits));
  } catch {
    process.stderr.write('[caveat:hook] pending reminder build or publish failed\n');
    process.exit(0);
  }
  if (!result.ran) process.exit(0);
  process.exit(0);
}

function cleanupWorkerDir(workDir: string | undefined, root: string | undefined): void {
  if (!workDir || !root || !isOwnedWorkerDir(workDir, root)) return;
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // The hook still must not fail when its detached-worker cleanup fails.
  }
}

function isOwnedWorkerDir(path: string, root = workerRoot()): boolean {
  try {
    const inputStat = lstatSync(path);
    if (inputStat.isSymbolicLink()) return false;
    const tmpRoot = realpathSync(root);
    const resolved = realpathSync(path);
    const stat = lstatSync(resolved);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    return dirname(resolved) === tmpRoot
      && basename(resolved).startsWith('job-')
      && stat.isDirectory()
      && !stat.isSymbolicLink()
      && hasPrivateOwnership(stat, uid);
  } catch {
    return false;
  }
}

export function sweepStaleWorkerDirs(now = Date.now(), root = workerRoot()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    process.stderr.write('[caveat:hook] worker stale cleanup failed\n');
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith('job-')) continue;
    const path = join(root, entry);
    try {
      if (!isOwnedWorkerDir(path, root)) continue;
      const stat = lstatSync(path);
      if (now - stat.mtimeMs <= WORKER_STALE_MS || !isStaleWorkerJobDir(path)) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      process.stderr.write('[caveat:hook] worker stale cleanup failed\n');
    }
  }
}

export function workerRoot(base = tmpdir()): string {
  const root = join(base, WORKER_ROOT);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !hasPrivateOwnership(stat, uid)) throw new Error('worker root is unsafe');
  const marker = join(root, WORKER_MARKER);
  try { writeFileSync(marker, 'caveat-worker/v1\n', { mode: 0o600, flag: 'wx' }); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
  const markerStat = lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || !hasPrivateOwnership(markerStat, uid) || readFileSync(marker, 'utf-8') !== 'caveat-worker/v1\n') throw new Error('worker root marker is invalid');
  return root;
}

function isStaleWorkerJobDir(path: string): boolean {
  const entries = readdirSync(path);
  if (entries.length !== 1 || !entries[0]!.endsWith('.json')) return false;
  const file = join(path, entries[0]!);
  const stat = lstatSync(file);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || !hasPrivateOwnership(stat, uid)) return false;
  return isKnownStaleWorkerJob(JSON.parse(readFileSync(file, 'utf-8')) as unknown);
}

function hasPrivateOwnership(stat: Stats, uid: number | undefined): boolean {
  // On Windows the reserved root lives below the current user's temp
  // directory and inherits its Windows ACL; structural marker/schema checks
  // remain mandatory. See isPrivateOwnerStat for the POSIX-mode semantics.
  return isPrivateOwnerStat(stat, uid);
}

function isWorkerJob(value: unknown): value is WorkerJob {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const keys = Object.keys(job).sort();
  if (!(keys.length === 4 && keys.join(',') === 'failureText,schemaVersion,sessionId,topicText') && !(keys.length === 5 && keys.join(',') === 'additionalContext,failureText,schemaVersion,sessionId,topicText')) return false;
  return job.schemaVersion === 'caveat-worker-job/v2' && typeof job.sessionId === 'string' && typeof job.topicText === 'string' && typeof job.failureText === 'string' && (job.additionalContext === undefined || (job.additionalContext !== null && typeof job.additionalContext === 'object' && !Array.isArray(job.additionalContext)));
}

function isKnownStaleWorkerJob(value: unknown): boolean {
  if (isWorkerJob(value)) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const keys = Object.keys(job).sort();
  if (!(keys.length === 3 && keys.join(',') === 'schemaVersion,searchText,sessionId')
    && !(keys.length === 4 && keys.join(',') === 'additionalContext,schemaVersion,searchText,sessionId')) return false;
  return job.schemaVersion === 'caveat-worker-job/v1'
    && typeof job.sessionId === 'string'
    && typeof job.searchText === 'string'
    && (job.additionalContext === undefined || (job.additionalContext !== null && typeof job.additionalContext === 'object' && !Array.isArray(job.additionalContext)));
}

function writeLastReindex(caveatHome: string, value: Record<string, unknown>): void {
  try {
    writeFileSync(join(caveatHome, 'index', '.last-reindex.json'), JSON.stringify(value), 'utf-8');
  } catch (err: unknown) {
    process.stderr.write(`[caveat:hook] reindex status write error: ${errorMessage(err)}\n`);
  }
}

async function runReindexWorker(): Promise<void> {
  if (process.env.CAVEAT_INDEX_AUTOSYNC === 'off') {
    process.stderr.write('[caveat:hook] auto reindex disabled by CAVEAT_INDEX_AUTOSYNC=off\n');
    return;
  }
  const ctx = buildContextSafely(CLAUDE_HOST);
  if (!ctx || !existsSync(ctx.paths.dbPath)) {
    process.stderr.write('[caveat:hook] auto reindex skipped: index database does not exist\n');
    return;
  }
  const lock = acquireReindexLock(ctx.caveatHome);
  if (!lock) return;
  const startedAt = new Date().toISOString();
  let db: DatabaseSync | undefined;
  try {
    const digest = computeEntriesDigest(ctx.paths);
    const keyProvider = createKeyserverKeyProvider({ caveatHome: ctx.caveatHome });
    const failures = await prewarmSealedKeys({ paths: ctx.paths, keyProvider });
    for (const failure of failures) {
      process.stderr.write(`[caveat:hook] ${failure.source}: sealed key prewarm failed: ${errorMessage(failure.error)}\n`);
    }
    db = openDb({ path: ctx.paths.dbPath, logger: silentLogger });
    const result = reindexAllSources({ db, paths: ctx.paths, logger: silentLogger, keyProvider });
    writeDigestMarker(ctx.caveatHome, digest);
    writeLastReindex(ctx.caveatHome, {
      startedAt,
      finishedAt: new Date().toISOString(),
      perSource: result.perSource,
    });
  } catch (err: unknown) {
    const msg = errorMessage(err);
    process.stderr.write(`[caveat:hook] reindex error: ${msg}\n`);
    writeLastReindex(ctx.caveatHome, {
      startedAt,
      finishedAt: new Date().toISOString(),
      error: msg,
    });
  } finally {
    db?.close();
    try {
      releaseReindexLock(lock);
    } catch (err: unknown) {
      process.stderr.write(`[caveat:hook] reindex lock release error: ${errorMessage(err)}\n`);
    }
  }
}

async function runAutoSyncWorker(): Promise<void> {
  if (process.env[CAVEAT_AUTO_SYNC_ENV] === 'off') {
    process.stderr.write('[caveat:hook] auto sync disabled by CAVEAT_AUTO_SYNC=off\n');
    return;
  }
  const ctx = buildContextSafely(CLAUDE_HOST);
  if (!ctx) return;
  try {
    await runAutoSync({
      caveatHome: ctx.caveatHome,
      ownDir: ctx.paths.knowledgeRepo,
      paths: ctx.paths,
      logger: silentLogger,
    });
  } catch (err: unknown) {
    process.stderr.write(`[caveat:hook] auto sync error: ${errorMessage(err)}\n`);
  }
}

export async function runHook(name: HookName, arg?: string): Promise<void> {
  try { sweepStaleWorkerDirs(); } catch { process.stderr.write('[caveat:hook] worker stale cleanup failed\n'); }
  if (name === 'reindex') {
    await runReindexWorker();
    process.exit(0);
  }
  if (name === 'autosync') {
    await runAutoSyncWorker();
    process.exit(0);
  }
  if (name === 'worker') {
    if (!arg) process.exit(0);
    await runWorker(arg);
    return;
  }

  let raw = '';
  try {
    raw = await readStdin();
  } catch (err: unknown) {
    process.stderr.write(`[caveat:hook] stdin read error: ${errorMessage(err)}\n`);
    process.exit(0);
  }
  const payload = parsePayload(CLAUDE_HOST, raw);
  const sessionId = getSessionId(payload);

  const pending = name === 'stop' ? null : peekForSession(CLAUDE_HOST, sessionId);
  const contexts = pending?.contexts ?? [];

  if (name === 'user-prompt-submit') {
    const ctx = buildContextSafely(CLAUDE_HOST);
    let jevNotice: JevNotice | null = null;
    if (ctx?.config.jevEnabled) {
      try {
        jevNotice = await runJevStruggle(ctx, 'claude', payload);
        if (jevNotice) contexts.push(jevNotice.text);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:hook] Jev判定に失敗: ${errorMessage(err)}\n`);
      }
    }
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const hits = searchCaveatsSafely(CLAUDE_HOST, { topicText: prompt, failureText: prompt, surface: 'user_prompt' });
    if (hits.length > 0) {
      contexts.push(userPromptSubmitReminderText(hits));
    }
    if (ctx) {
      try {
        const prepared = prepareSessionDelivery(ctx.caveatHome, sessionId, contexts, jevNotice?.ref ? [jevNotice.ref] : []);
        const sent = prepared.texts.length === 0 || await emitHookContext(CLAUDE_HOST, `${systemReminderOutput(prepared.texts.join('\n\n'))}\n`);
        if (sent) {
          prepared.delivered();
          if (jevNotice && prepared.texts.includes(jevNotice.text)) jevNotice.delivered();
          if (pending) acknowledgeSessionReminders(CLAUDE_HOST, pending);
        }
      } catch (err: unknown) { process.stderr.write(`[caveat:hook] 配送に失敗: ${errorMessage(err)}\n`); }
    }
    process.exit(0);
  }

  if (name === 'post-tool-use') {
    const ctx = buildContextSafely(CLAUDE_HOST);
    if (ctx) {
      try {
        const prepared = prepareSessionDelivery(ctx.caveatHome, sessionId, contexts);
        const sent = prepared.texts.length === 0 || await emitHookContext(CLAUDE_HOST, `${systemReminderOutput(prepared.texts.join('\n\n'))}\n`);
        if (sent) {
          prepared.delivered();
          if (pending) acknowledgeSessionReminders(CLAUDE_HOST, pending);
        }
      } catch (err: unknown) { process.stderr.write(`[caveat:hook] 配送に失敗: ${errorMessage(err)}\n`); }
    }
    // Fast path: we only enqueue on errors. Everything else is just drain.
    if (!isToolError(payload)) process.exit(0);
    const errText = extractToolResponseText(
      payload.tool_response ?? payload.toolResponse ?? payload.error ?? payload,
    );
    if (errText) {
      const topicText = toolTopicText(payload);
      spawnWorker({ sessionId, topicText, failureText: errText });
    }
    process.exit(0);
  }

  if (name === 'stop') {
    // Periodic, debounced housekeeping: sweep stale per-session pending
    // dirs at most once per debounce window. Best-effort — never block the
    // hook contract on cleanup failures.
    const ctx = buildContextSafely(CLAUDE_HOST);
    if (ctx) {
      try {
        maybeSweepPendingDirs(ctx.caveatHome);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:hook] pending sweep error: ${errorMessage(err)}\n`);
      }
      try {
        maybeTriggerAutoReindex(ctx);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:hook] auto reindex trigger error: ${errorMessage(err)}\n`);
      }
      try {
        maybeTriggerAutoSync(ctx);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:hook] auto sync trigger error: ${errorMessage(err)}\n`);
      }
    }
    if (payload.stop_hook_active === true) process.exit(0);
    if (ctx?.config.jevEnabled) process.exit(0);
    const transcriptPath =
      typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const signals = transcriptPath ? loadSignalsSafely(transcriptPath) : null;
    if (!signals || !hasAnyStruggleSignal(signals)) process.exit(0);
    const related = searchCaveatsSafely(CLAUDE_HOST, signals.errorSnippets.map((failureText) => ({
      topicText: '',
      failureText,
      surface: 'stop' as const,
    })));
    queueStopForSession(CLAUDE_HOST, sessionId, signals, related, () => stopReminderText(signals, related));
    process.exit(0);
  }

  process.stderr.write(`[caveat:hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
