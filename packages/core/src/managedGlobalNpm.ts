import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { globalNpmEnvironment } from './platform.js';

export type GlobalNpmEvent = { event: 'issued' | 'started' | 'exit' | 'close' | 'unknown'; pid: number | null; code?: number | null; signal?: string | null };
export type GlobalNpmReceipt = {
  status: 'completed' | 'unknown'; pid: number | null; spawned: boolean; exitObserved: boolean; closeObserved: boolean;
  exitCode: number | null; signal: string | null; terminationRequested: boolean; outputBytes: number; outputSha256: string; reason: string | null;
};
export type GlobalNpmCommand = { node: string; script: string; prefix: string; runDirectory: string; userConfig: string; globalConfig: string };
export function globalUninstallArguments(command: GlobalNpmCommand) {
  return ['-e', 'process.umask(0o077);require(process.argv[1]);', command.script, 'uninstall', '--global', '--prefix', command.prefix,
    '--ignore-scripts', '--no-audit', '--no-fund', '--offline', '--no-update-notifier', '--userconfig', command.userConfig,
    '--globalconfig', command.globalConfig, '--cache', join(command.runDirectory, 'cache'), '--logs-max=0', 'caveat-cli'];
}

/** No shell, inherited Node options, user npm configuration or raw child output. Only this child may be terminated. */
export function runGlobalNpmUninstall(command: GlobalNpmCommand, onEvent: (event: GlobalNpmEvent) => void = () => {}) {
  return runOwnedGlobalNpm(command.node, globalUninstallArguments(command), command.runDirectory, globalNpmEnvironment(command.node, command.runDirectory), onEvent);
}

/** Fixture binder, never a CLI command/deadline override. */
export function runOwnedGlobalNpm(node: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onEvent: (event: GlobalNpmEvent) => void, deadlineMs = 60000): Promise<GlobalNpmReceipt> {
  assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 60000, 'global_npm_deadline_invalid');
  return new Promise(resolve => {
    onEvent({ event: 'issued', pid: null });
    const child = spawn(node, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const hash = createHash('sha256'); let outputBytes = 0, spawned = false, exitObserved = false, closeObserved = false;
    let code: number | null = null, signal: string | null = null, reason: string | null = null, settled = false, terminationRequested = false;
    let teardown: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); if (teardown) clearTimeout(teardown);
      resolve({ status: !reason && spawned && exitObserved && closeObserved && code === 0 && signal === null ? 'completed' : 'unknown',
        pid: child.pid ?? null, spawned, exitObserved, closeObserved, exitCode: code, signal, terminationRequested, outputBytes, outputSha256: hash.digest('hex'), reason });
    };
    const emit = (event: GlobalNpmEvent) => { try { onEvent(event); } catch { stop('global_npm_receipt_failed'); } };
    const stop = (why: string) => {
      reason ??= why; if (settled || teardown) return;
      if (!exitObserved) { terminationRequested = true; child.kill('SIGTERM'); }
      teardown = setTimeout(() => {
        if (settled) return;
        // Releasing owned capture handles does not prove pipe close or terminate any descendant.
        child.stdout.destroy(); child.stderr.destroy(); child.unref(); emit({ event: 'unknown', pid: child.pid ?? null }); finish();
      }, 1000);
    };
    const timer = setTimeout(() => stop('global_npm_timeout'), deadlineMs);
    child.on('spawn', () => { spawned = true; emit({ event: 'started', pid: child.pid! }); });
    const capture = (chunk: Buffer) => {
      if (settled) return; outputBytes += chunk.length;
      hash.update(chunk); if (outputBytes > 1024 * 1024) stop('global_npm_output_bound');
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', () => { reason ??= 'global_npm_spawn_failed'; });
    child.on('exit', (value, received) => { exitObserved = true; code = value; signal = received; emit({ event: 'exit', pid: child.pid ?? null, code, signal }); });
    child.on('close', (value, received) => {
      if (settled) return; closeObserved = true; code = value; signal = received;
      if (code !== 0 || signal !== null) reason ??= 'global_npm_exit_unconfirmed';
      emit({ event: 'close', pid: child.pid ?? null, code, signal }); finish();
    });
  });
}
