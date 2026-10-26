import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';
import { WINDOWS_ACL_TIMEOUT_MS } from './privateWindowsAcl.js';
import { ACL_REPLY_BYTES, type AclReply, type AclWork } from './privateWindowsAclProtocol.js';

// Import failures must signal the first synchronous waiter too: a normal Worker
// error event cannot run in the main thread while it is inside Atomics.wait.
const BOOTSTRAP = String.raw`
const {workerData,parentPort}=require('node:worker_threads');
import(workerData.moduleUrl).then(m=>m.startAclWorker(workerData)).catch(error=>{
 const work=workerData.initial, data=Buffer.from(JSON.stringify({sequence:work.operation.sequence,ok:false,terminal:true,error:'store_unsafe: ACL worker unavailable '+(error.code||error.name||'unknown')}));
 new Uint8Array(work.buffer,8,data.length).set(data);const h=new Int32Array(work.buffer,0,2);Atomics.store(h,1,data.length);Atomics.store(h,0,1);Atomics.notify(h,0);parentPort.close();
});`;

/** Injection is internal to core tests; the CLI has no setting that changes the
 * helper, deadline or script. No process/thread is created until the first ACL. */
export interface WindowsAclSessionOptions {
  workerUrl?: URL;
  timeoutMs?: number;
  workerOptions?: Record<string, unknown>;
}
export function createWindowsAclSession(options: WindowsAclSessionOptions = {}) {
  let worker: Worker | undefined;
  let sequence = 0;
  let closed = false;
  let failure: Error | undefined;
  let terminal = false;
  const timeout = options.timeoutMs ?? WINDOWS_ACL_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > WINDOWS_ACL_TIMEOUT_MS) throw Error('store_unsafe: invalid ACL timeout');
  const request = (operation: AclWork['operation'], closing = false): void => {
    const work: AclWork = { operation, buffer: new SharedArrayBuffer(8 + ACL_REPLY_BYTES) };
    const header = new Int32Array(work.buffer, 0, 2);
    if (!worker) {
      const moduleUrl = options.workerUrl ?? new URL('./privateWindowsAclWorker.js', import.meta.url);
      if (!statSync(fileURLToPath(moduleUrl)).isFile()) throw Error('store_unsafe: ACL worker missing');
      worker = new Worker(BOOTSTRAP, { eval: true, execArgv: [], workerData: { moduleUrl: moduleUrl.href, initial: work, options: options.workerOptions ?? {} } });
      worker.on('error', error => { failure = error; });
    } else worker.postMessage(work);
    if (Atomics.wait(header, 0, 0, closing ? 2_000 : timeout) === 'timed-out') {
      worker.postMessage({ cancel: operation.sequence });
      const cleanup = Atomics.wait(header, 0, 0, 1_000) !== 'timed-out';
      throw Error(`store_unsafe: powershell spawn ETIMEDOUT${cleanup ? '' : '; cleanup unconfirmed'}`);
    }
    const length = Atomics.load(header, 1);
    if (length < 1 || length > ACL_REPLY_BYTES) throw Error('store_unsafe: ACL worker invalid reply length');
    const response = JSON.parse(Buffer.from(new Uint8Array(work.buffer, 8, length)).toString()) as AclReply;
    if (response.sequence !== operation.sequence || typeof response.ok !== 'boolean') throw Error('store_unsafe: ACL worker invalid sequence');
    if (response.terminal) terminal = true;
    if (!response.ok) throw Error(response.error ?? 'store_unsafe: ACL worker failed');
  };
  return {
    run(path: string, directory: boolean, apply: boolean): void {
      if (closed) throw Error('store_unsafe: ACL session closed');
      if (terminal) throw Error('store_unsafe: ACL worker unavailable');
      if (failure) throw Error(`store_unsafe: ACL worker failed ${failure.name}`);
      request({ sequence: ++sequence, path, directory, apply });
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (!worker) return;
      if (terminal) { worker.unref(); return; }
      try { request({ sequence: ++sequence, close: true }, true); }
      finally {
        // The worker acknowledges close only after its owned child has closed.
        // unref does not terminate a process or conceal an unconfirmed cleanup.
        worker.unref();
      }
    },
  };
}
