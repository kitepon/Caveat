import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { loadConfig } from './config.js';
import { acknowledgeRuntimeErrors, runtimeErrorsConfigPath, runtimeErrorsInternal, type RuntimeErrorOptions } from './runtimeErrors.js';

// Caveat never knows where reports go: the destination and the signing secret
// live in a host-issued credential file that the user names in ~/.caveatrc.json.
// Nothing is sent unless `runtimeErrors` is true AND that path is configured.
export const RUNTIME_ERROR_REPORT_SCHEMA_VERSION = '1.0';
const REPORT_STATE_SCHEMA = 'caveat.runtime_error_report_state.v1';
const REPORT_STATUS_SCHEMA = 'caveat.runtime_error_report_status.v1';
const REPORT_RESULT_SCHEMA = 'caveat.runtime_error_report.v1';
const PRODUCT_ID = 'caveat';
const MAX_CREDENTIAL_BYTES = 4096;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const WINDOWS_ACL_TIMEOUT_MS = 30_000;
const MINUTE_MS = 60_000;
// The receiver accepts one report per minute per host; the contract asks for
// "only when something is pending, and at most hourly". Transient failures
// retry sooner so a laptop that was off the LAN catches up after it returns.
const RETRY_AFTER_ACCEPTED_MS = 60 * MINUTE_MS;
const RETRY_AFTER_TRANSIENT_MS = 10 * MINUTE_MS;
const RETRY_AFTER_CLOCK_MS = 60 * MINUTE_MS;
const RETRY_AFTER_OPERATOR_MS = 6 * 60 * MINUTE_MS;

const OUTCOME_RETRY_MS = {
  accepted: RETRY_AFTER_ACCEPTED_MS,
  in_flight: RETRY_AFTER_TRANSIENT_MS,
  unreachable: RETRY_AFTER_TRANSIENT_MS,
  timeout: RETRY_AFTER_TRANSIENT_MS,
  server_error: RETRY_AFTER_TRANSIENT_MS,
  rate_limited: RETRY_AFTER_TRANSIENT_MS,
  report_id_conflict: RETRY_AFTER_TRANSIENT_MS,
  response_unverified: RETRY_AFTER_TRANSIENT_MS,
  timestamp_skew: RETRY_AFTER_CLOCK_MS,
  observed_at_skew: RETRY_AFTER_CLOCK_MS,
  unauthorized: RETRY_AFTER_OPERATOR_MS,
  forbidden: RETRY_AFTER_OPERATOR_MS,
  invalid_report: RETRY_AFTER_OPERATOR_MS,
  report_too_large: RETRY_AFTER_OPERATOR_MS,
  unexpected_status: RETRY_AFTER_OPERATOR_MS,
  credential_unavailable: RETRY_AFTER_OPERATOR_MS,
  credential_unsafe: RETRY_AFTER_OPERATOR_MS,
  credential_invalid: RETRY_AFTER_OPERATOR_MS,
  version_invalid: RETRY_AFTER_OPERATOR_MS,
  store_unavailable: RETRY_AFTER_OPERATOR_MS,
} as const;
export type RuntimeErrorReportOutcome = keyof typeof OUTCOME_RETRY_MS;
type ReportState = { schema: typeof REPORT_STATE_SCHEMA; last_attempt_at: string | null; last_outcome: RuntimeErrorReportOutcome | null; last_accepted_at: string | null; next_attempt_at: string | null };
type ReportCredential = { url: string; keyId: string; secret: string };
type ReportRow = { fingerprint: string; error_code: string; component: string; message_template: string; severity: string; status: 'open'; occurrence_count: number; first_seen: string; last_seen: string; product_version: string; state_schema_version: string };
type ReportResolution = { fingerprint: string; resolved_at: string; reason_code: string };
export type RuntimeErrorReportOptions = RuntimeErrorOptions & {
  /** Background workers honour the retry window; an explicit operator run does not. */
  respectRetryWindow?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  credentialAclRunner?: (path: string) => void;
};
export type RuntimeErrorReportResult = {
  schema: typeof REPORT_RESULT_SCHEMA;
  status: 'sent' | 'nothing_pending' | 'disabled' | 'not_configured' | 'waiting' | 'failed';
  outcome: RuntimeErrorReportOutcome | null;
  runtime_error_count: number;
  resolution_count: number;
  acknowledged_through: number | null;
};

const { collectionEnabled, optionsFor, lock, readStore, ensureSafeDir, secureWindowsAcl, assertPosix, now, validVersion } = runtimeErrorsInternal;
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const validTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const emptyState = (): ReportState => ({ schema: REPORT_STATE_SCHEMA, last_attempt_at: null, last_outcome: null, last_accepted_at: null, next_attempt_at: null });
const result = (status: RuntimeErrorReportResult['status'], outcome: RuntimeErrorReportOutcome | null = null, counts: { errors?: number; resolutions?: number; acknowledged?: number | null } = {}): RuntimeErrorReportResult => ({ schema: REPORT_RESULT_SCHEMA, status, outcome, runtime_error_count: counts.errors ?? 0, resolution_count: counts.resolutions ?? 0, acknowledged_through: counts.acknowledged ?? null });

function reportStatePath(storePath: string) { return join(dirname(storePath), 'runtime-error-report.json'); }

/** Configured credential path, or null when reporting is off. Never throws. */
function configuredCredentialPath(options: RuntimeErrorOptions): string | null {
  try {
    const value = loadConfig(options.configPath ?? runtimeErrorsConfigPath(options.env ?? process.env)).runtimeErrorReportCredentialFile;
    return typeof value === 'string' && value.length > 0 && isAbsolute(value) ? value : null;
  } catch { return null; }
}

// The file holds a signing secret, so it is refused unless only its owner can
// read it. SYSTEM and Administrators are tolerated because every file under a
// Windows user profile inherits them, and because a file written from an
// elevated session (an SSH login, for one) is owned by Administrators rather
// than by the user. Any other owner or allowed principal is refused.
const WINDOWS_CREDENTIAL_ACL_VERIFY = String.raw`$ErrorActionPreference='Stop';$p=$env:CAVEAT_ACL_PATH;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$acl=Get-Acl -LiteralPath $p;$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;$trusted=@($sid,'S-1-5-18','S-1-5-32-544');if($trusted -notcontains $owner){exit 41};foreach($r in @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))){if($r.AccessControlType -eq 'Allow' -and ($trusted -notcontains $r.IdentityReference.Value)){exit 44}}`;
export function runWindowsCredentialAcl(path: string) {
  const run = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREDENTIAL_ACL_VERIFY], { env: { ...process.env, CAVEAT_ACL_PATH: path }, encoding: 'utf-8', timeout: WINDOWS_ACL_TIMEOUT_MS, windowsHide: true });
  if (run.error !== undefined) throw Error(`credential_unsafe: powershell spawn ${(run.error as NodeJS.ErrnoException).code ?? run.error.message}`);
  if (run.status !== 0) throw Error(`credential_unsafe: powershell exit=${run.status} signal=${run.signal ?? 'none'}`);
}

class ReportFailure extends Error { constructor(readonly outcome: RuntimeErrorReportOutcome) { super(outcome); } }

function loadCredential(path: string, isWin: boolean, options: RuntimeErrorReportOptions): ReportCredential {
  let text: string;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CREDENTIAL_BYTES) throw new ReportFailure('credential_unsafe');
    if (isWin) (options.credentialAclRunner ?? runWindowsCredentialAcl)(path);
    else if ((before.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw new ReportFailure('credential_unsafe');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || after.size > MAX_CREDENTIAL_BYTES) throw new ReportFailure('credential_unsafe');
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  } catch (error) {
    if (error instanceof ReportFailure) throw error;
    throw new ReportFailure(plain(error) && error.code === 'ENOENT' ? 'credential_unavailable' : 'credential_unsafe');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ReportFailure('credential_invalid'); }
  if (!plain(value) || typeof value.url !== 'string' || typeof value.key_id !== 'string' || typeof value.secret !== 'string') throw new ReportFailure('credential_invalid');
  let url: URL;
  try { url = new URL(value.url); } catch { throw new ReportFailure('credential_invalid'); }
  // key_id travels inside a comma-separated header, and the secret is used as raw UTF-8 key bytes.
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.key_id) || value.secret.length < 16 || value.secret.length > 1024) throw new ReportFailure('credential_invalid');
  return { url: url.toString(), keyId: value.key_id, secret: value.secret };
}

export function signRuntimeErrorReport(secret: string, ts: string, body: Uint8Array): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${ts}\n${bodyHash}`).digest('hex');
}
export function signRuntimeErrorReportReceipt(secret: string, reportId: string, receivedAt: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${reportId}\n${receivedAt}`).digest('hex');
}
function sameHex(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || !/^[0-9a-f]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function readReportState(path: string): ReportState {
  // Scheduling hints only: a damaged file means "no history", never a failure.
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!plain(value) || value.schema !== REPORT_STATE_SCHEMA) return emptyState();
    const time = (v: unknown) => (validTime(v) ? v : null);
    const outcome = typeof value.last_outcome === 'string' && Object.hasOwn(OUTCOME_RETRY_MS, value.last_outcome) ? value.last_outcome as RuntimeErrorReportOutcome : null;
    return { schema: REPORT_STATE_SCHEMA, last_attempt_at: time(value.last_attempt_at), last_outcome: outcome, last_accepted_at: time(value.last_accepted_at), next_attempt_at: time(value.next_attempt_at) };
  } catch { return emptyState(); }
}
function writeReportState(path: string, state: ReportState, isWin: boolean, options: RuntimeErrorOptions) {
  ensureSafeDir(dirname(path), isWin, options);
  const temporary = join(dirname(path), `.runtime-error-report-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
    if (isWin) secureWindowsAcl(temporary, options.aclRunner, false, true); else assertPosix(lstatSync(temporary), 0o600);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
function nextState(previous: ReportState, outcome: RuntimeErrorReportOutcome, at: string): ReportState {
  return { schema: REPORT_STATE_SCHEMA, last_attempt_at: at, last_outcome: outcome, last_accepted_at: outcome === 'accepted' ? at : previous.last_accepted_at, next_attempt_at: new Date(Date.parse(at) + OUTCOME_RETRY_MS[outcome]).toISOString() };
}

type Claim = { rows: ReportRow[]; resolutions: ReportResolution[]; cursor: number; state: ReportState };
/** Take the send slot under the store lock so concurrent workers cannot both send. */
function claimPending(storePath: string, isWin: boolean, at: string, options: RuntimeErrorReportOptions): Claim | 'nothing_pending' | 'waiting' {
  if (!existsSync(storePath)) return 'nothing_pending';
  return lock(storePath, isWin, () => {
    const statePath = reportStatePath(storePath); const state = readReportState(statePath);
    if (options.respectRetryWindow && state.next_attempt_at !== null && Date.parse(at) < Date.parse(state.next_attempt_at)) return 'waiting' as const;
    const store = readStore(storePath, isWin, options);
    const pending = store.records.filter((record) => record.sequence > store.acknowledged_through);
    if (pending.length === 0) return 'nothing_pending' as const;
    const claimed = nextState(state, 'in_flight', at);
    writeReportState(statePath, claimed, isWin, options);
    return {
      rows: pending.filter((r) => r.status === 'open').map((r) => ({ fingerprint: r.fingerprint, error_code: r.error_code, component: r.component, message_template: r.message_template, severity: r.severity, status: 'open' as const, occurrence_count: r.count, first_seen: r.first_seen, last_seen: r.last_seen, product_version: r.product_version, state_schema_version: r.state_schema_version })),
      resolutions: pending.filter((r) => r.status === 'resolved').map((r) => ({ fingerprint: r.fingerprint, resolved_at: r.resolved_at as string, reason_code: r.reason_code as string })),
      cursor: pending.at(-1)!.sequence,
      state: claimed,
    };
  }, options);
}

function errorCodeOf(text: string): string | null {
  try { const value: unknown = JSON.parse(text); if (!plain(value)) return null; return typeof value.error === 'string' ? value.error : typeof value.code === 'string' ? value.code : null; } catch { return null; }
}
async function post(credential: ReportCredential, reportId: string, ts: string, body: Buffer, options: RuntimeErrorReportOptions): Promise<RuntimeErrorReportOutcome> {
  let status: number; let text: string;
  try {
    const response = await (options.fetchImpl ?? fetch)(credential.url, {
      method: 'POST',
      // A redirect would re-send the signed report to a host the credential never named.
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `BugHub-HMAC-SHA256 key_id=${credential.keyId}, ts=${ts}, sig=${signRuntimeErrorReport(credential.secret, ts, body)}` },
      // Exactly the bytes that were hashed for the signature.
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    const bytes = Buffer.from(await response.arrayBuffer());
    text = bytes.length > MAX_RESPONSE_BYTES ? '' : bytes.toString('utf8');
  } catch (error) {
    return plain(error) && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'unreachable';
  }
  if (status === 200) {
    // The destination is plain HTTP on a private address, so a 200 from some
    // other machine must not count: only a receipt signed with our secret does.
    let value: unknown;
    try { value = JSON.parse(text); } catch { return 'response_unverified'; }
    if (!plain(value) || value.accepted !== true || value.report_id !== reportId || typeof value.received_at !== 'string') return 'response_unverified';
    return sameHex(signRuntimeErrorReportReceipt(credential.secret, reportId, value.received_at), value.sig) ? 'accepted' : 'response_unverified';
  }
  if (status === 401) return errorCodeOf(text) === 'timestamp_skew' ? 'timestamp_skew' : 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'report_id_conflict';
  if (status === 413) return 'report_too_large';
  if (status === 422) return errorCodeOf(text) === 'observed_at_skew' ? 'observed_at_skew' : 'invalid_report';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server_error' : 'unexpected_status';
}

/**
 * Send the unacknowledged runtime errors once. The cursor advances only after a
 * receipt signed by the receiver; every other outcome leaves the records pending
 * and is remembered as a fixed outcome code, never as a runtime error itself.
 */
export async function sendRuntimeErrorReport(options: RuntimeErrorReportOptions = {}): Promise<RuntimeErrorReportResult> {
  if (!collectionEnabled(options)) return result('disabled');
  const credentialPath = configuredCredentialPath(options);
  if (credentialPath === null) return result('not_configured');
  // An unsafe or corrupt store cannot be read, claimed, or acknowledged. Say so
  // instead of throwing: `runtime-errors diagnostics` already reports the cause.
  try { return await sendPending(credentialPath, options); } catch { return result('failed', 'store_unavailable'); }
}
async function sendPending(credentialPath: string, options: RuntimeErrorReportOptions): Promise<RuntimeErrorReportResult> {
  const { path: storePath, isWin } = optionsFor(options);
  const at = now(options);
  const claim = claimPending(storePath, isWin, at, options);
  if (claim === 'nothing_pending' || claim === 'waiting') return result(claim);
  const counts = { errors: claim.rows.length, resolutions: claim.resolutions.length };
  const finish = (outcome: RuntimeErrorReportOutcome, acknowledged: number | null = null) => {
    lock(storePath, isWin, () => writeReportState(reportStatePath(storePath), nextState(claim.state, outcome, at), isWin, options), options);
    return result(outcome === 'accepted' ? 'sent' : 'failed', outcome, { ...counts, acknowledged });
  };
  const version = options.version;
  if (!validVersion(version)) return finish('version_invalid');
  let credential: ReportCredential;
  try { credential = loadCredential(credentialPath, isWin, options); }
  catch (error) { return finish(error instanceof ReportFailure ? error.outcome : 'credential_unsafe'); }
  const reportId = randomUUID();
  // observed_at and ts come from one instant: the receiver rejects a report whose two clocks disagree.
  const ts = String(Math.floor(Date.parse(at) / 1000));
  const body = Buffer.from(JSON.stringify({ schema_version: RUNTIME_ERROR_REPORT_SCHEMA_VERSION, report_id: reportId, product_id: PRODUCT_ID, installed_version: version, observed_at: at, runtime_errors: claim.rows, resolutions: claim.resolutions }), 'utf8');
  const outcome = await post(credential, reportId, ts, body, options);
  if (outcome !== 'accepted') return finish(outcome);
  const acknowledged = acknowledgeRuntimeErrors(claim.cursor, options).cursor.acknowledged_through;
  return finish('accepted', acknowledged);
}

/**
 * Cheap, lock-free check for hook paths: is a background send worth spawning?
 * It skips the ownership checks on purpose (those spawn PowerShell on Windows);
 * the worker repeats every check before it reads or sends anything.
 */
export function runtimeErrorReportDue(options: RuntimeErrorOptions = {}): boolean {
  try {
    if (!collectionEnabled(options) || configuredCredentialPath(options) === null) return false;
    const { path: storePath } = optionsFor(options);
    if (!existsSync(storePath)) return false;
    const store: unknown = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!plain(store) || typeof store.next_sequence !== 'number' || typeof store.acknowledged_through !== 'number' || store.next_sequence - 1 <= store.acknowledged_through) return false;
    const next = readReportState(reportStatePath(storePath)).next_attempt_at;
    return next === null || Date.parse(now(options)) >= Date.parse(next);
  } catch { return false; }
}

export function runtimeErrorReportStatus(options: RuntimeErrorOptions = {}) {
  const base = { schema: REPORT_STATUS_SCHEMA, pending_count: 0, last_attempt_at: null as string | null, last_outcome: null as RuntimeErrorReportOutcome | null, last_accepted_at: null as string | null, next_attempt_at: null as string | null };
  if (!collectionEnabled(options)) return { ...base, reporting: 'disabled' as const, status: 'not_applicable' as const };
  if (configuredCredentialPath(options) === null) return { ...base, reporting: 'not_configured' as const, status: 'not_applicable' as const };
  try {
    const { path: storePath, isWin } = optionsFor(options);
    const store = existsSync(storePath) ? readStore(storePath, isWin, options) : null;
    const state = readReportState(reportStatePath(storePath));
    return { schema: REPORT_STATUS_SCHEMA, reporting: 'enabled' as const, status: 'ready' as const, pending_count: store ? store.records.filter((record) => record.sequence > store.acknowledged_through).length : 0, last_attempt_at: state.last_attempt_at, last_outcome: state.last_outcome, last_accepted_at: state.last_accepted_at, next_attempt_at: state.next_attempt_at };
  } catch { return { ...base, reporting: 'enabled' as const, status: 'unavailable' as const }; }
}
