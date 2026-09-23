import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  buildAndPublishPendingReminder,
  buildPendingSemanticKey,
  hasAnyStruggleSignal,
  maybeSweepPendingDirs,
  readCodexSessionSignals,
  stopReminderText,
  toolErrorReminderText,
  userPromptSubmitReminderText,
  type SessionSignals,
} from '@caveat/core';
import { maybeTriggerAutoReindex } from '../autoReindexTrigger.js';
import { maybeTriggerAutoSync } from '../autoSyncTrigger.js';
import { detectCodexHookInstallation } from '../codexHookInstall.js';
import { runJevStruggle, type JevNotice } from '../jevStruggle.js';
import { prepareSessionDelivery } from '../hookDelivery.js';
import {
  acknowledgeSessionReminders,
  buildContextSafely,
  emitHookContext,
  errorMessage,
  extractToolResponseText,
  parsePayload,
  peekForSession,
  pendingCleanupFailureText,
  queueStopForSession,
  readStdin,
  searchCaveatsSafely,
  type HookHost,
} from '../hookShared.js';

export type CodexHookName =
  | 'user-prompt-submit'
  | 'post-tool-use'
  | 'stop'
  | 'worker'
  | 'diagnostics';

const CODEX_HOST: HookHost = {
  agent: 'codex',
  stderrTag: 'caveat:codex-hook',
  errorCode: 'CAVEAT.CODEX_HOOK_FAILED',
  stopStateDir: 'codex-stop-state',
  stopDedupeKey: 'codex-stop-reminder',
};

interface CodexWorkerJob {
  sessionId: string;
  topicText: string;
  failureText: string;
  knownError?: boolean;
  allowSymptomOnly?: boolean;
  transcriptPath?: string;
  toolUseId?: string;
}

function loadSignalsSafely(path: string): SessionSignals | null {
  try {
    return readCodexSessionSignals(path);
  } catch (err: unknown) {
    process.stderr.write(`[caveat:codex-hook] transcript read error: ${errorMessage(err)}\n`);
    return null;
  }
}

function codexSessionId(payload: Record<string, unknown>): string | null {
  const v = payload.session_id ?? payload.sessionId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numericExitCode(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function processExitCodeFromText(text: string): number | null {
  const m = /Process exited with code\s+(-?\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

function transcriptToolOutput(transcriptPath: string, toolUseId: string): string | null {
  if (!transcriptPath || !toolUseId || !existsSync(transcriptPath)) return null;

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  for (const line of raw.split('\n')) {
    if (!line.includes(toolUseId)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const payloadObj = (parsed as { payload?: unknown }).payload;
    if (payloadObj === null || typeof payloadObj !== 'object') continue;
    const p = payloadObj as Record<string, unknown>;
    if (p.type !== 'function_call_output' || p.call_id !== toolUseId) continue;
    return typeof p.output === 'string' ? p.output : '';
  }
  return null;
}

function transcriptExitCode(payload: Record<string, unknown>): number | null {
  const transcriptPath =
    typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '';
  const output = transcriptToolOutput(transcriptPath, toolUseId);
  return output === null ? null : processExitCodeFromText(output);
}

function isShellLikeTool(payload: Record<string, unknown>): boolean {
  const name = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (name === 'Bash' || name === 'exec_command') return true;
  const input = payload.tool_input;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const r = input as Record<string, unknown>;
    return typeof r.command === 'string' || typeof r.cmd === 'string';
  }
  return false;
}

function toolInputText(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '';
  const r = input as Record<string, unknown>;
  const command = r.command ?? r.cmd;
  return typeof command === 'string' ? command : '';
}

export function isCodexToolError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  const topExit = numericExitCode(payload.exit_code ?? payload.exitCode);
  if (topExit !== null) return topExit !== 0;
  const resp = payload.tool_response ?? payload.toolResponse;
  if (resp !== null && typeof resp === 'object' && !Array.isArray(resp)) {
    const r = resp as Record<string, unknown>;
    if (r.is_error === true) return true;
    const exit = numericExitCode(r.exit_code ?? r.exitCode);
    if (exit !== null) return exit !== 0;
  }
  const responseExit = processExitCodeFromText(extractToolResponseText(resp));
  if (responseExit !== null) return responseExit !== 0;
  const transcriptExit = transcriptExitCode(payload);
  if (transcriptExit !== null) return transcriptExit !== 0;
  return false;
}

export function buildCodexPostToolUseWorkerJob(
  payload: Record<string, unknown>,
): CodexWorkerJob | null {
  const sessionId = codexSessionId(payload);
  if (!sessionId) return null;

  const transcriptPath =
    typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined;
  const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : undefined;
  const responseText = extractToolResponseText(payload.tool_response ?? payload.toolResponse);
  const inputText = toolInputText(payload.tool_input);
  const transcriptOutput =
    transcriptPath && toolUseId ? transcriptToolOutput(transcriptPath, toolUseId) : null;
  const topicText = inputText.trim();
  const failureText = [responseText, transcriptOutput ?? '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');

  const knownError = isCodexToolError(payload);
  if (knownError) {
    return { sessionId, topicText, failureText, knownError: true, transcriptPath, toolUseId };
  }

  if (transcriptPath && toolUseId && isShellLikeTool(payload) && (topicText || failureText)) {
    return {
      sessionId,
      topicText,
      failureText,
      knownError: false,
      allowSymptomOnly: true,
      transcriptPath,
      toolUseId,
    };
  }

  return null;
}

export function codexContextOutput(text: string, eventName = 'UserPromptSubmit'): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: text,
    },
  });
}

export function codexPendingCleanupFailureText(): string {
  return pendingCleanupFailureText(CODEX_HOST);
}

function spawnCodexWorker(job: CodexWorkerJob): void {
  const workFile = join(
    tmpdir(),
    `caveat-codex-worker-${Date.now()}-${randomBytes(4).toString('hex')}.json`,
  );
  try {
    writeFileSync(workFile, JSON.stringify(job), {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err: unknown) {
    process.stderr.write(`[caveat:codex-hook] worker writefile error: ${errorMessage(err)}\n`);
    return;
  }

  const cliScript = process.argv[1];
  if (!cliScript) return;
  try {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', cliScript, 'codex-hook', 'worker', workFile],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch (err: unknown) {
    process.stderr.write(`[caveat:codex-hook] worker spawn error: ${errorMessage(err)}\n`);
    try {
      unlinkSync(workFile);
    } catch {
      // ignore
    }
  }
}

async function waitForTranscriptOutput(
  transcriptPath: string,
  toolUseId: string,
): Promise<string | null> {
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    const output = transcriptToolOutput(transcriptPath, toolUseId);
    if (output !== null) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function processCodexWorkerJob(
  job: CodexWorkerJob,
  opts: { waitForTranscript: boolean } = { waitForTranscript: true },
): Promise<void> {
  if ((!job.topicText && !job.failureText) || !job.sessionId) return;
  let failureText = job.failureText;
  let knownError = job.knownError === true;
  if (opts.waitForTranscript && job.transcriptPath && job.toolUseId) {
    const transcriptOutput = await waitForTranscriptOutput(job.transcriptPath, job.toolUseId);
    if (transcriptOutput) {
      const exit = processExitCodeFromText(transcriptOutput);
      if (exit !== null) {
        if (exit === 0) return;
        knownError = true;
      }
      failureText = [failureText, transcriptOutput].filter(Boolean).join('\n');
    }
  }

  if (!knownError && job.allowSymptomOnly !== true) return;

  const hits = searchCaveatsSafely(CODEX_HOST, {
    topicText: job.topicText,
    failureText,
    surface: 'tool_error',
  });
  if (hits.length === 0) return;

  const ctx = buildContextSafely(CODEX_HOST);
  if (!ctx) return;
  let result: ReturnType<typeof buildAndPublishPendingReminder>;
  try {
    result = buildAndPublishPendingReminder(ctx.caveatHome, job.sessionId, buildPendingSemanticKey({
      agent: 'codex', surface: 'tool_error', refs: hits,
    }), () => toolErrorReminderText(hits, 'native-cli'));
  } catch {
    process.stderr.write('[caveat:codex-hook] pending reminder build or publish failed\n');
    return;
  }
  if (!result.ran) return;
}

async function runCodexWorker(workFile: string): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(workFile, 'utf-8');
  } catch {
    process.exit(0);
  }
  try {
    unlinkSync(workFile);
  } catch {
    // best-effort
  }
  let job: CodexWorkerJob;
  try {
    job = JSON.parse(raw) as CodexWorkerJob;
  } catch {
    process.exit(0);
  }
  await processCodexWorkerJob(job);
  process.exit(0);
}

function runDiagnostics(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')): void {
  const features = spawnSync('codex', ['features', 'list'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
    env: codexFeatureListEnv(codexHome),
  });
  const featureOutput = [features.stdout, features.stderr].filter(Boolean).join('\n');
  const hasHooks = /^hooks\s+\S+\s+true\b/m.test(featureOutput);
  const installation = detectCodexHookInstallation(codexHome);
  const result = {
    availability:
      features.error || features.status !== 0 || !hasHooks ? 'unavailable' : 'available',
    codexBinary: features.error ? 'missing' : 'present',
    codexHooksFeature: hasHooks ? 'enabled' : 'not-enabled',
    installation: installation.installation,
    codexHome,
    hooksPath: installation.hooksPath,
    installedHooks: installation.hooks,
    legacyTimeoutSec: installation.legacyTimeoutSec,
    evidence: featureOutput
      .split('\n')
      .find((line) => line.trim().startsWith('hooks')) ?? null,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function codexFeatureListEnv(
  codexHome: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...inherited, CODEX_HOME: codexHome };
}

export async function runCodexHook(name: CodexHookName, arg?: string): Promise<void> {
  if (name === 'diagnostics') {
    runDiagnostics(arg);
    return;
  }
  if (name === 'worker') {
    if (!arg) process.exit(0);
    await runCodexWorker(arg);
    return;
  }

  let raw = '';
  try {
    raw = await readStdin();
  } catch (err: unknown) {
    process.stderr.write(`[caveat:codex-hook] stdin read error: ${errorMessage(err)}\n`);
    process.exit(0);
  }
  const payload = parsePayload(CODEX_HOST, raw);
  const sessionId = codexSessionId(payload);
  if (!sessionId) process.stderr.write('[caveat:codex-hook] missing session_id; pending drain disabled\n');

  if (name === 'user-prompt-submit') {
    const pending = sessionId ? peekForSession(CODEX_HOST, sessionId) : null;
    const contexts = pending?.contexts ?? [];
    const ctx = buildContextSafely(CODEX_HOST);
    let jevNotice: JevNotice | null = null;
    if (ctx?.config.jevEnabled) {
      try {
        jevNotice = await runJevStruggle(ctx, 'codex', payload);
        if (jevNotice) contexts.push(jevNotice.text);
      } catch (err: unknown) {
        process.stderr.write(`[caveat:codex-hook] Jev判定に失敗: ${errorMessage(err)}\n`);
      }
    }
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const hits = searchCaveatsSafely(CODEX_HOST, { topicText: prompt, failureText: prompt, surface: 'user_prompt' });
    if (hits.length > 0) {
      contexts.push(userPromptSubmitReminderText(hits, 'native-cli'));
    }
    if (ctx) {
      try {
        const prepared = prepareSessionDelivery(ctx.caveatHome, sessionId ?? '_unknown', contexts, jevNotice?.ref ? [jevNotice.ref] : []);
        const sent = prepared.texts.length === 0 || await emitHookContext(CODEX_HOST, `${codexContextOutput(prepared.texts.join('\n\n'))}\n`);
        if (sent) {
          prepared.delivered();
          if (jevNotice && prepared.texts.includes(jevNotice.text)) jevNotice.delivered();
          if (pending) acknowledgeSessionReminders(CODEX_HOST, pending);
        }
      } catch (err: unknown) { process.stderr.write(`[caveat:codex-hook] 配送に失敗: ${errorMessage(err)}\n`); }
    }
    process.exit(0);
  }

  if (name === 'post-tool-use') {
    const job = buildCodexPostToolUseWorkerJob(payload);
    if (job) await processCodexWorkerJob(job, { waitForTranscript: false });
    process.exit(0);
  }

  if (name === 'stop') {
    try {
      const ctx = buildContextSafely(CODEX_HOST);
      if (ctx) {
        try {
          maybeSweepPendingDirs(ctx.caveatHome);
        } catch (err: unknown) {
          process.stderr.write(`[caveat:codex-hook] pending sweep error: ${errorMessage(err)}\n`);
        }
        maybeTriggerAutoReindex(ctx);
        try {
          maybeTriggerAutoSync(ctx);
        } catch (err: unknown) {
          process.stderr.write(`[caveat:codex-hook] auto sync trigger error: ${errorMessage(err)}\n`);
        }
      }
    } catch (err: unknown) {
      process.stderr.write(`[caveat:codex-hook] auto reindex trigger error: ${errorMessage(err)}\n`);
    }
    if (payload.stop_hook_active === true) process.exit(0);
    if (buildContextSafely(CODEX_HOST)?.config.jevEnabled) process.exit(0);
    const transcriptPath =
      typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
    const signals = transcriptPath ? loadSignalsSafely(transcriptPath) : null;
    if (!signals || !hasAnyStruggleSignal(signals)) process.exit(0);
    const related = searchCaveatsSafely(CODEX_HOST, signals.errorSnippets.map((failureText) => ({
      topicText: '',
      failureText,
      surface: 'stop' as const,
    })));
    if (sessionId) queueStopForSession(CODEX_HOST, sessionId, signals, related, () => stopReminderText(signals, related, 'native-cli'));
    process.exit(0);
  }

  process.stderr.write(`[caveat:codex-hook] unknown hook name: ${name}\n`);
  process.exit(0);
}
