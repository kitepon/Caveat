import { afterEach, describe, expect, it } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordRuntimeError, runtimeErrorsConfigPath, runtimeErrorsSnapshot, runtimeErrorsStatePath, setRuntimeErrorStatus } from '../src/runtimeErrors.js';
import { runtimeErrorReportDue, runtimeErrorReportStatus, sendRuntimeErrorReport, signRuntimeErrorReport, signRuntimeErrorReportReceipt, type RuntimeErrorReportOptions } from '../src/runtimeErrorReport.js';

const SECRET = 'caveat-test-secret-0123456789abcdef';
const KEY_ID = 'test-key.1';
const VERSION = '1.2.3';
const windowsHost = process.platform === 'win32';
// The store and credential ACL checks spawn PowerShell on Windows. They have
// their own tests; here they are stubbed so the wire behaviour stays fast.
const fast: RuntimeErrorReportOptions = windowsHost ? { aclRunner: () => {}, credentialAclRunner: () => {} } : {};

type Request = { headers: IncomingMessage['headers']; body: Buffer };
type Reply = (request: Request, response: ServerResponse) => void;
const servers: Server[] = [];
async function receiver(reply: Reply) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => { const received = { headers: request.headers, body: Buffer.concat(chunks) }; requests.push(received); reply(received, response); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/products/v1/runtime-errors`, requests };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))); });

function json(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); }
const accept: Reply = (request, response) => {
  const reportId = (JSON.parse(request.body.toString('utf8')) as { report_id: string }).report_id; const receivedAt = '2026-10-03T08:00:01.000Z';
  json(response, 200, { accepted: true, report_id: reportId, duplicate: false, received_at: receivedAt, sig: signRuntimeErrorReportReceipt(SECRET, reportId, receivedAt) });
};

function host(url: string | null, credential: unknown = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'caveat-report-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_STATE_HOME: join(root, 'state') };
  const credentialFile = join(root, 'credentials', 'caveat.json');
  mkdirSync(dirname(credentialFile), { recursive: true });
  if (url !== null) writeFileSync(credentialFile, JSON.stringify(credential ?? { url, key_id: KEY_ID, secret: SECRET }), { mode: 0o600 });
  writeFileSync(runtimeErrorsConfigPath(env), JSON.stringify({ runtimeErrors: true, runtimeErrorReportCredentialFile: credentialFile }));
  return { root, env, credentialFile };
}
const at = (iso: string, env: NodeJS.ProcessEnv, extra: RuntimeErrorReportOptions = {}): RuntimeErrorReportOptions => ({ ...fast, env, version: VERSION, now: iso, ...extra });
const pending = (env: NodeJS.ProcessEnv) => runtimeErrorsSnapshot(0, 256, { ...fast, env, version: VERSION }).diagnostics.pending_count;

describe('runtime error report', { timeout: windowsHost ? 60_000 : 10_000 }, () => {
  it('署名は契約の試験値と一致する', () => {
    const body = Buffer.from('{"schema_version":"1.0","report_id":"00000000-0000-4000-8000-000000000001","product_id":"caveat","installed_version":"0.19.13","observed_at":"2026-09-21T14:13:20.000Z","runtime_errors":[],"resolutions":[]}', 'utf8');
    expect(body.length).toBe(205);
    expect(createHash('sha256').update(body).digest('hex')).toBe('6a8ae99ecebde0f6d50b8e8d5273604c6e02c3df150645bd96de0e79d7710b2f');
    expect(signRuntimeErrorReport('bughub-test-secret-do-not-use-0123456789abcdef', '1790000000', body)).toBe('e4ba0355c9d9058286a82d9622747eae264f780aa575e74859c40a6e529fa73a');
    expect(signRuntimeErrorReportReceipt('bughub-test-secret-do-not-use-0123456789abcdef', '00000000-0000-4000-8000-000000000001', '2026-09-21T14:13:21.000Z')).toBe('cc4ebb409cdd6a2be5f69f6acf8ebcd7f18acbe14b9ac82836797572f74a64bb');
  });

  it('設定が無ければ通信も状態の作成もしない', async () => {
    const { url, requests } = await receiver(accept);
    const { root, env } = host(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    writeFileSync(runtimeErrorsConfigPath(env), JSON.stringify({ runtimeErrors: true }));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'not_configured', outcome: null });
    expect(runtimeErrorReportDue(at('2026-10-03T08:00:00.000Z', env))).toBe(false);
    writeFileSync(runtimeErrorsConfigPath(env), JSON.stringify({ runtimeErrors: false, runtimeErrorReportCredentialFile: join(root, 'credentials', 'caveat.json') }));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'disabled' });
    writeFileSync(runtimeErrorsConfigPath(env), JSON.stringify({ runtimeErrors: true, runtimeErrorReportCredentialFile: 'relative/caveat.json' }));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'not_configured' });
    expect(requests).toHaveLength(0);
    expect(existsSync(join(dirname(runtimeErrorsStatePath(env)), 'runtime-error-report.json'))).toBe(false);
  });

  it('未受領の記録だけを署名して送り、署名付きの受領でだけcursorを進める', async () => {
    const { url, requests } = await receiver(accept);
    const { root, env } = host(url);
    expect(await sendRuntimeErrorReport(at('2026-10-03T07:59:00.000Z', env))).toMatchObject({ status: 'nothing_pending' });
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:30:00.000Z', env));
    const resolved = recordRuntimeError('CAVEAT.INDEX_FAILED', at('2026-10-03T07:40:00.000Z', env));
    if (resolved.status !== 'recorded') throw Error('fixture');
    setRuntimeErrorStatus(resolved.fingerprint, 'resolved', at('2026-10-03T07:50:00.000Z', env));
    expect(runtimeErrorReportDue(at('2026-10-03T08:00:00.000Z', env))).toBe(true);

    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'sent', outcome: 'accepted', runtime_error_count: 1, resolution_count: 1, acknowledged_through: 4 });
    expect(requests).toHaveLength(1);
    const { headers, body } = requests[0]!;
    const ts = String(Date.parse('2026-10-03T08:00:00.000Z') / 1000);
    const expected = createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(`${ts}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
    expect(headers.authorization).toBe(`BugHub-HMAC-SHA256 key_id=${KEY_ID}, ts=${ts}, sig=${expected}`);
    expect(headers['content-type']).toBe('application/json');
    const report = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual(['schema_version', 'report_id', 'product_id', 'installed_version', 'observed_at', 'runtime_errors', 'resolutions']);
    expect(report).toMatchObject({ schema_version: '1.0', product_id: 'caveat', installed_version: VERSION, observed_at: '2026-10-03T08:00:00.000Z' });
    expect(report.report_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(report.runtime_errors).toEqual([{ fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), error_code: 'CAVEAT.SYNC_FAILED', component: 'sync', message_template: 'Caveat own sync failed', severity: 'high', status: 'open', occurrence_count: 2, first_seen: '2026-10-03T07:00:00.000Z', last_seen: '2026-10-03T07:30:00.000Z', product_version: VERSION, state_schema_version: '1.0' }]);
    expect(report.resolutions).toEqual([{ fingerprint: resolved.fingerprint, resolved_at: '2026-10-03T07:50:00.000Z', reason_code: 'operator_resolved' }]);
    // 端末名・パス・秘密は本文にも、端末に残す送信状態にも入らない。
    expect(body.toString('utf8')).not.toContain(root);
    expect(body.toString('utf8')).not.toContain(SECRET);
    const state = readFileSync(join(dirname(runtimeErrorsStatePath(env)), 'runtime-error-report.json'), 'utf8');
    expect(JSON.parse(state)).toEqual({ schema: 'caveat.runtime_error_report_state.v1', last_attempt_at: '2026-10-03T08:00:00.000Z', last_outcome: 'accepted', last_accepted_at: '2026-10-03T08:00:00.000Z', next_attempt_at: '2026-10-03T09:00:00.000Z' });

    expect(pending(env)).toBe(0);
    expect(runtimeErrorReportDue(at('2026-10-03T10:00:00.000Z', env))).toBe(false);
    expect(await sendRuntimeErrorReport(at('2026-10-03T10:00:00.000Z', env))).toMatchObject({ status: 'nothing_pending' });
    expect(requests).toHaveLength(1);
  });

  it('解決を取り消した記録は、回数と最終時刻を変えずに未解決として送り直す', async () => {
    const { url, requests } = await receiver(accept);
    const { env } = host(url);
    const recorded = recordRuntimeError('CAVEAT.MCP_TOOL_FAILED', at('2026-10-03T07:00:00.000Z', env));
    if (recorded.status !== 'recorded') throw Error('fixture');
    setRuntimeErrorStatus(recorded.fingerprint, 'resolved', at('2026-10-03T07:10:00.000Z', env));
    await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env));
    setRuntimeErrorStatus(recorded.fingerprint, 'open', at('2026-10-03T08:10:00.000Z', env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T09:30:00.000Z', env))).toMatchObject({ status: 'sent', runtime_error_count: 1, resolution_count: 0 });
    const reopened = JSON.parse(requests[1]!.body.toString('utf8')) as { runtime_errors: Array<Record<string, unknown>>; resolutions: unknown[] };
    expect(reopened.runtime_errors[0]).toMatchObject({ fingerprint: recorded.fingerprint, status: 'open', occurrence_count: 1, last_seen: '2026-10-03T07:00:00.000Z' });
    expect(reopened.resolutions).toEqual([]);
  });

  it.each([
    ['署名の無い200', (_request: Request, response: ServerResponse) => json(response, 200, { accepted: true, report_id: 'x', duplicate: false, received_at: '2026-10-03T08:00:01.000Z' }), 'response_unverified'],
    ['別の鍵で署名した200', (request: Request, response: ServerResponse) => { const id = (JSON.parse(request.body.toString('utf8')) as { report_id: string }).report_id; json(response, 200, { accepted: true, report_id: id, duplicate: false, received_at: 't', sig: signRuntimeErrorReportReceipt('another-secret-0123456789', id, 't') }); }, 'response_unverified'],
    ['別のreport_idへの受領', (_request: Request, response: ServerResponse) => json(response, 200, { accepted: true, report_id: 'other', duplicate: false, received_at: 't', sig: signRuntimeErrorReportReceipt(SECRET, 'other', 't') }), 'response_unverified'],
    ['accepted以外の200', (request: Request, response: ServerResponse) => { const id = (JSON.parse(request.body.toString('utf8')) as { report_id: string }).report_id; json(response, 200, { accepted: false, report_id: id, received_at: 't', sig: signRuntimeErrorReportReceipt(SECRET, id, 't') }); }, 'response_unverified'],
    ['JSONでない200', (_request: Request, response: ServerResponse) => { response.writeHead(200); response.end('<html>ok</html>'); }, 'response_unverified'],
    ['401', (_request: Request, response: ServerResponse) => json(response, 401, { error: 'unauthorized' }), 'unauthorized'],
    ['時刻ずれの401', (_request: Request, response: ServerResponse) => json(response, 401, { error: 'timestamp_skew', server_time: '2026-10-03T09:00:00.000Z' }), 'timestamp_skew'],
    ['403', (_request: Request, response: ServerResponse) => json(response, 403, { error: 'credential_inactive' }), 'forbidden'],
    ['409', (_request: Request, response: ServerResponse) => json(response, 409, { error: 'report_id_conflict' }), 'report_id_conflict'],
    ['413', (_request: Request, response: ServerResponse) => json(response, 413, { error: 'report_too_large' }), 'report_too_large'],
    ['422', (_request: Request, response: ServerResponse) => json(response, 422, { error: 'invalid_report', violations: [] }), 'invalid_report'],
    ['時刻ずれの422', (_request: Request, response: ServerResponse) => json(response, 422, { error: 'observed_at_skew' }), 'observed_at_skew'],
    ['429', (_request: Request, response: ServerResponse) => json(response, 429, { error: 'rate_limited' }), 'rate_limited'],
    ['500', (_request: Request, response: ServerResponse) => { response.writeHead(500); response.end('boom'); }, 'server_error'],
    ['想定外の状態', (_request: Request, response: ServerResponse) => { response.writeHead(204); response.end(); }, 'unexpected_status'],
  ] as const)('%s は受領済みにせず、記録を残す', async (_name, reply, outcome) => {
    const { url, requests } = await receiver(reply);
    const { env } = host(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'failed', outcome, runtime_error_count: 1, acknowledged_through: null });
    expect(requests).toHaveLength(1);
    expect(pending(env)).toBe(1);
    expect(runtimeErrorReportStatus(at('2026-10-03T08:00:30.000Z', env))).toMatchObject({ reporting: 'enabled', status: 'ready', pending_count: 1, last_outcome: outcome, last_accepted_at: null });
  });

  it('転送には従わず、転送先へ署名付きの報告を渡さない', async () => {
    const target = await receiver(accept);
    const { url, requests } = await receiver((_request, response) => { response.writeHead(307, { location: target.url }); response.end(); });
    const { env } = host(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'failed', outcome: 'unreachable' });
    expect(requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
    expect(pending(env)).toBe(1);
  });

  it('届かない宛先と応答しない宛先は記録を残し、次の機会へ回す', async () => {
    const closed = await receiver(accept);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    const first = host(closed.url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', first.env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', first.env))).toMatchObject({ status: 'failed', outcome: 'unreachable' });
    expect(pending(first.env)).toBe(1);

    const silent = await receiver(() => {});
    const second = host(silent.url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', second.env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', second.env, { timeoutMs: 200 }))).toMatchObject({ status: 'failed', outcome: 'timeout' });
    expect(pending(second.env)).toBe(1);
    servers.at(-1)!.closeAllConnections();
  });

  it('背景の送信は再試行までの間隔を守り、明示の実行は守らない', async () => {
    let fail = true;
    const { url, requests } = await receiver((request, response) => (fail ? json(response, 500, {}) : accept(request, response)));
    const { env } = host(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    const background = (iso: string) => sendRuntimeErrorReport(at(iso, env, { respectRetryWindow: true }));
    expect(await background('2026-10-03T08:00:00.000Z')).toMatchObject({ status: 'failed', outcome: 'server_error' });
    expect(runtimeErrorReportDue(at('2026-10-03T08:09:59.000Z', env))).toBe(false);
    expect(await background('2026-10-03T08:09:59.000Z')).toMatchObject({ status: 'waiting' });
    expect(requests).toHaveLength(1);
    fail = false;
    expect(runtimeErrorReportDue(at('2026-10-03T08:10:00.000Z', env))).toBe(true);
    expect(await background('2026-10-03T08:10:00.000Z')).toMatchObject({ status: 'sent' });
    // 受領のあとは、新しい記録があっても1時間は背景から送らない。
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T08:20:00.000Z', env));
    expect(await background('2026-10-03T09:09:59.000Z')).toMatchObject({ status: 'waiting' });
    expect(requests).toHaveLength(2);
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:30:00.000Z', env))).toMatchObject({ status: 'sent', runtime_error_count: 1 });
    expect(requests).toHaveLength(3);
    expect((JSON.parse(requests[2]!.body.toString('utf8')) as { runtime_errors: Array<{ occurrence_count: number }> }).runtime_errors[0]?.occurrence_count).toBe(2);
  });

  it('送信中に増えた記録は、受領のあとも未受領のまま残る', async () => {
    const { env } = host('http://127.0.0.1:9/unused');
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    const fetchImpl: typeof fetch = async (_input, init) => {
      recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T08:00:00.500Z', env));
      const reportId = (JSON.parse(Buffer.from(init!.body as Uint8Array).toString('utf8')) as { report_id: string }).report_id;
      return new Response(JSON.stringify({ accepted: true, report_id: reportId, duplicate: false, received_at: 'r', sig: signRuntimeErrorReportReceipt(SECRET, reportId, 'r') }), { status: 200 });
    };
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env, { fetchImpl }))).toMatchObject({ status: 'sent', acknowledged_through: 1 });
    expect(pending(env)).toBe(1);
  });

  it('版がSemVerでなければ送らない', async () => {
    const { url, requests } = await receiver(accept);
    const { env } = host(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    expect(await sendRuntimeErrorReport({ ...fast, env, now: '2026-10-03T08:00:00.000Z', version: 'unknown' })).toMatchObject({ status: 'failed', outcome: 'version_invalid' });
    expect(requests).toHaveLength(0);
    expect(pending(env)).toBe(1);
  });

  it.each([
    ['ファイルが無い', null, 'credential_unavailable'],
    ['JSONでない', '{bad', 'credential_invalid'],
    ['秘密が文字列でない', { url: 'http://127.0.0.1:9/', key_id: KEY_ID, secret: 12345678901234567890 }, 'credential_invalid'],
    ['秘密が短い', { url: 'http://127.0.0.1:9/', key_id: KEY_ID, secret: 'short' }, 'credential_invalid'],
    ['key_idに区切り文字がある', { url: 'http://127.0.0.1:9/', key_id: 'a, ts=1', secret: SECRET }, 'credential_invalid'],
    ['宛先がhttpでない', { url: 'file:///etc/passwd', key_id: KEY_ID, secret: SECRET }, 'credential_invalid'],
    ['宛先に認証情報がある', { url: 'http://user:pass@127.0.0.1:9/', key_id: KEY_ID, secret: SECRET }, 'credential_invalid'],
  ] as const)('credentialの%s時は送らない', async (_name, credential, outcome) => {
    const { url, requests } = await receiver(accept);
    const { env, credentialFile } = host(credential === null ? null : url, typeof credential === 'string' ? undefined : credential ?? undefined);
    if (typeof credential === 'string') writeFileSync(credentialFile, credential, { mode: 0o600 });
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'failed', outcome });
    expect(requests).toHaveLength(0);
    expect(pending(env)).toBe(1);
    // 設定の誤りは6時間あけて背景から試し直す。
    expect(runtimeErrorReportDue(at('2026-10-03T13:59:59.000Z', env))).toBe(false);
    expect(runtimeErrorReportDue(at('2026-10-03T14:00:00.000Z', env))).toBe(true);
  });

  it.skipIf(windowsHost)('本人以外が読めるcredentialとシンボリックリンクを拒否する', async () => {
    const { url, requests } = await receiver(accept);
    const open = host(url);
    chmodSync(open.credentialFile, 0o640);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', open.env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', open.env))).toMatchObject({ status: 'failed', outcome: 'credential_unsafe' });

    const linked = host(null);
    const real = join(linked.root, 'real.json');
    writeFileSync(real, JSON.stringify({ url, key_id: KEY_ID, secret: SECRET }), { mode: 0o600 });
    symlinkSync(real, linked.credentialFile);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', linked.env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', linked.env))).toMatchObject({ status: 'failed', outcome: 'credential_unsafe' });
    expect(requests).toHaveLength(0);
  });

  it('credentialに知らない項目が足されていても、必要な3項目で送る', async () => {
    const { url, requests } = await receiver(accept);
    const { env, credentialFile } = host(url);
    writeFileSync(credentialFile, JSON.stringify({ url, key_id: KEY_ID, secret: SECRET, issued_at: '2026-10-03T00:00:00.000Z' }), { mode: 0o600 });
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'sent' });
    expect(requests[0]!.body.toString('utf8')).not.toContain('issued_at');
  });

  it('storeが壊れている時は例外を投げず、送らずに失敗として返す', async () => {
    const { url, requests } = await receiver(accept);
    const { env } = host(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    writeFileSync(runtimeErrorsStatePath(env), '{"schema":"caveat.runtime_errors.v1","next_sequence":2,"acknowledged_through":0,"records":[{"unexpected":true}]}');
    expect(await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ status: 'failed', outcome: 'store_unavailable', runtime_error_count: 0 });
    expect(requests).toHaveLength(0);
  });

  it('送信の失敗そのものは実行時エラーとして記録しない', async () => {
    const { url } = await receiver((_request, response) => json(response, 500, {}));
    const { env } = host(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', at('2026-10-03T07:00:00.000Z', env));
    await sendRuntimeErrorReport(at('2026-10-03T08:00:00.000Z', env));
    const snapshot = runtimeErrorsSnapshot(0, 256, { ...fast, env, version: VERSION });
    expect(snapshot.runtime_errors.map((entry) => entry.error_code)).toEqual(['CAVEAT.SYNC_FAILED']);
    expect(snapshot.runtime_errors[0]?.occurrence_count).toBe(1);
  });

  it('状態の報告は、送信が無効・未設定・有効を区別する', () => {
    const { env } = host('http://127.0.0.1:9/unused');
    expect(runtimeErrorReportStatus(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ schema: 'caveat.runtime_error_report_status.v1', reporting: 'enabled', status: 'ready', pending_count: 0, last_outcome: null });
    writeFileSync(runtimeErrorsConfigPath(env), JSON.stringify({ runtimeErrors: true }));
    expect(runtimeErrorReportStatus(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ reporting: 'not_configured', status: 'not_applicable' });
    writeFileSync(runtimeErrorsConfigPath(env), JSON.stringify({}));
    expect(runtimeErrorReportStatus(at('2026-10-03T08:00:00.000Z', env))).toMatchObject({ reporting: 'disabled', status: 'not_applicable' });
  });
});
