import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { parentPort } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { reply, windowsAclSessionProgram, type AclOperation, type AclWork } from './privateWindowsAclProtocol.js';

type ChildState = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<{ code: number | null; signal: string | null }>;
  stderr: string;
  stdoutBytes: number;
  pending?: { operation: AclOperation; resolve: () => void; reject: (error: Error) => void };
};
const BUFFER_LIMIT = 1024 * 1024;
export function startAclWorker(data: { initial: AclWork; options?: { command?: string; args?: string[] } }): void {
  if (!parentPort) throw Error('ACL worker requires its parent');
  const port = parentPort;
  let processState: ChildState | undefined;
  let active: AclWork | undefined;
  const errorFor = (state: ChildState, code: number | null, signal: string | null) => Error(`store_unsafe: powershell exit=${code} signal=${signal ?? 'none'} stderr=${state.stderr.replace(/\s+/g, ' ').trim().slice(0, 400) || '(empty)'}`);
  const fail = (state: ChildState, error: Error) => {
    const pending = state.pending; state.pending = undefined;
    pending?.reject(error);
    // Only the ChildProcess handle created by this worker can be terminated.
    state.child.kill();
  };
  function ensureProcess(): ChildState {
    if (processState) return processState;
    const child = spawn(data.options?.command ?? 'pwsh.exe', data.options?.args ?? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsAclSessionProgram()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let finish!: (value: { code: number | null; signal: string | null }) => void;
    const state: ChildState = { child, closed: new Promise(resolve => { finish = resolve; }), stderr: '', stdoutBytes: 0 };
    processState = state;
    child.stdout.on('data', bytes => { state.stdoutBytes += bytes.length; if (state.stdoutBytes > BUFFER_LIMIT) fail(state, Error('store_unsafe: powershell spawn ENOBUFS')); });
    for (const stream of [child.stdout, child.stderr]) stream.on('error', error => fail(state, Error(`store_unsafe: powershell spawn ${(error as NodeJS.ErrnoException).code ?? error.name}`)));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      const pending = state.pending;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (!pending || Object.keys(value).sort().join(',') !== 'ok,sequence' || value.ok !== true || value.sequence !== pending.operation.sequence) throw Error('store_unsafe: powershell invalid response');
        state.pending = undefined; pending.resolve();
      } catch { fail(state, Error('store_unsafe: powershell invalid response')); }
    });
    child.stderr.on('data', bytes => {
      if (Buffer.byteLength(state.stderr) + bytes.length > BUFFER_LIMIT) fail(state, Error('store_unsafe: powershell spawn ENOBUFS'));
      else state.stderr += bytes.toString();
    });
    child.stdin.on('error', error => fail(state, Error(`store_unsafe: powershell spawn ${(error as NodeJS.ErrnoException).code ?? error.name}`)));
    child.on('error', error => fail(state, Error(`store_unsafe: powershell spawn ${(error as NodeJS.ErrnoException).code ?? error.name}`)));
    child.on('close', (code, signal) => {
      lines.close();
      if (processState === state) processState = undefined;
      const pending = state.pending; state.pending = undefined;
      pending?.reject(errorFor(state, code, signal));
      finish({ code, signal });
    });
    return state;
  }
  async function perform(work: AclWork): Promise<void> {
    if (active) { reply(work, { sequence: work.operation.sequence, ok: false, error: 'store_unsafe: ACL worker concurrent request' }); return; }
    active = work;
    let error: string | undefined;
    let helperPid: number | undefined;
    try {
      if ('close' in work.operation) {
        const state = processState;
        helperPid = state?.child.pid;
        if (state) {
          state.child.stdin.end();
          const timer = setTimeout(() => state.child.kill(), 1_000);
          const result = await state.closed;
          clearTimeout(timer);
          if (result.code !== 0) throw errorFor(state, result.code, result.signal);
        }
      } else {
        const previous = processState;
        if (previous && (previous.child.killed || previous.child.exitCode !== null || previous.child.signalCode !== null)) await previous.closed;
        const state = ensureProcess(); helperPid = state.child.pid; state.stderr = ''; state.stdoutBytes = 0;
        await new Promise<void>((resolve, reject) => {
          state.pending = { operation: work.operation as AclOperation, resolve, reject };
          state.child.stdin.write(JSON.stringify(work.operation) + '\n');
        });
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'store_unsafe: ACL worker failure';
      // A failed interpreter is closed before the next store can start another.
      const state = processState;
      if (state) { state.child.kill(); await state.closed; }
    }
    active = undefined;
    reply(work, { sequence: work.operation.sequence, ok: error === undefined, ...(error ? { error } : {}), ...(helperPid ? { helperPid } : {}) });
    if ('close' in work.operation) port.close();
  }
  port.on('message', (message: AclWork | { cancel: number }) => {
    if ('cancel' in message) {
      if (active?.operation.sequence === message.cancel) processState?.child.kill();
      return;
    }
    void perform(message);
  });
  void perform(data.initial);
}
