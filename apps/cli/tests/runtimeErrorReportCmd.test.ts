import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRuntimeError, runtimeErrorsConfigPath, signRuntimeErrorReportReceipt } from '@caveat/core';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(repo, 'apps', 'cli', 'dist', 'caveat.js');
const SECRET = 'caveat-cli-test-secret-0123456789';
const windowsHost = process.platform === 'win32';

// The receiver runs in this process, so the CLI must be spawned asynchronously:
// spawnSync would block the event loop that has to answer it.
function run(args: string[], env: NodeJS.ProcessEnv, stdin = '') {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const servers: Server[] = [];
async function receiver(reply: (reportId: string, response: ServerResponse) => void) {
  const reports: Array<Record<string, any>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => { const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>; reports.push(report); reply(report.report_id, response); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/products/v1/runtime-errors`, reports };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))); });
const accept = (reportId: string, response: ServerResponse) => {
  const receivedAt = new Date().toISOString();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ accepted: true, report_id: reportId, duplicate: false, received_at: receivedAt, sig: signRuntimeErrorReportReceipt(SECRET, reportId, receivedAt) }));
};

function isolated(url: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'caveat-report-cli-'));
  const home = join(root, 'home'); const caveatHome = join(root, 'caveat');
  mkdirSync(home, { recursive: true }); mkdirSync(caveatHome, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(root, 'local-app-data'), CAVEAT_HOME: caveatHome, XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_STATE_HOME: join(root, 'xdg-state'), CAVEAT_AUTO_SYNC: 'off', CAVEAT_INDEX_AUTOSYNC: 'off' };
  const credentialFile = join(root, 'caveat-credential.json');
  if (url !== null) writeFileSync(credentialFile, JSON.stringify({ url, key_id: 'cli-test', secret: SECRET }), { mode: 0o600 });
  writeFileSync(runtimeErrorsConfigPath(env), JSON.stringify(url === null ? { runtimeErrors: true } : { runtimeErrors: true, runtimeErrorReportCredentialFile: credentialFile }));
  return { env };
}
const lastLine = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, any>;

describe('caveat runtime-errors report', { timeout: windowsHost ? 180_000 : 30_000 }, () => {
  it('未受領の記録を送り、受領後は状態と未受領件数に反映する', async () => {
    const { url, reports } = await receiver(accept);
    const { env } = isolated(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', { env, version: '0.19.0' });
    const sent = await run(['runtime-errors', 'report', '--json'], env);
    expect(sent.status, sent.stderr).toBe(0);
    expect(lastLine(sent.stdout)).toMatchObject({ schema: 'caveat.runtime_error_report.v1', status: 'sent', outcome: 'accepted', runtime_error_count: 1, resolution_count: 0, acknowledged_through: 1 });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ schema_version: '1.0', product_id: 'caveat', runtime_errors: [{ error_code: 'CAVEAT.SYNC_FAILED', occurrence_count: 1, product_version: '0.19.0' }], resolutions: [] });
    expect(reports[0]!.installed_version).toMatch(/^\d+\.\d+\.\d+/);
    const status = await run(['runtime-errors', 'report-status', '--json'], env);
    expect(lastLine(status.stdout)).toMatchObject({ schema: 'caveat.runtime_error_report_status.v1', reporting: 'enabled', status: 'ready', pending_count: 0, last_outcome: 'accepted' });
    const again = await run(['runtime-errors', 'report', '--json'], env);
    expect(again.status).toBe(0);
    expect(lastLine(again.stdout)).toMatchObject({ status: 'nothing_pending' });
    expect(reports).toHaveLength(1);
  });

  it('受け口が失敗を返した時は非0で終わり、記録を残す', async () => {
    const { url } = await receiver((_reportId, response) => { response.writeHead(500); response.end(); });
    const { env } = isolated(url);
    recordRuntimeError('CAVEAT.SYNC_FAILED', { env, version: '0.19.0' });
    const failed = await run(['runtime-errors', 'report', '--json'], env);
    expect(failed.status).toBe(1);
    expect(lastLine(failed.stdout)).toMatchObject({ status: 'failed', outcome: 'server_error', acknowledged_through: null });
    expect(lastLine((await run(['runtime-errors', 'report-status', '--json'], env)).stdout)).toMatchObject({ pending_count: 1, last_outcome: 'server_error' });
  });

  it('credentialの場所を設定していなければ送らない', async () => {
    const { reports } = await receiver(accept);
    const { env } = isolated(null);
    recordRuntimeError('CAVEAT.SYNC_FAILED', { env, version: '0.19.0' });
    const result = await run(['runtime-errors', 'report', '--json'], env);
    expect(result.status).toBe(0);
    expect(lastLine(result.stdout)).toMatchObject({ status: 'not_configured', outcome: null });
    expect(lastLine((await run(['runtime-errors', 'report-status', '--json'], env)).stdout)).toMatchObject({ reporting: 'not_configured', status: 'not_applicable' });
    expect(reports).toHaveLength(0);
  });

  it('失敗したhookは待たされずに終わり、切り離したworkerが記録を送る', async () => {
    const { url, reports } = await receiver(accept);
    const { env } = isolated(url);
    const hook = await run(['hook', 'user-prompt-submit'], env, '{not json');
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe('');
    const deadline = Date.now() + (windowsHost ? 120_000 : 20_000);
    while (reports.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.runtime_errors).toMatchObject([{ error_code: 'CAVEAT.CLAUDE_HOOK_FAILED', component: 'claude_hook', status: 'open', occurrence_count: 1 }]);
    // workerが受領を書き終えるまで待つ。
    let status: Record<string, any> = {};
    while (Date.now() < deadline) { status = lastLine((await run(['runtime-errors', 'report-status', '--json'], env)).stdout); if (status.last_outcome === 'accepted') break; await new Promise((resolve) => setTimeout(resolve, 200)); }
    expect(status).toMatchObject({ pending_count: 0, last_outcome: 'accepted' });
  });
});
