import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsSystemPath } from '../packages/core/dist/platform.js';

function native() {
  const koffi = createRequire(new URL('../packages/core/package.json', import.meta.url))('koffi');
  const kernel = koffi.load('kernel32.dll');
  return { koffi,
    create: kernel.func('void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)'),
    close: kernel.func('int __stdcall CloseHandle(void *handle)'),
    error: kernel.func('uint32_t __stdcall GetLastError()'),
    mapping: kernel.func('void * __stdcall CreateFileMappingW(void *file, void *security, uint32_t protection, uint32_t high, uint32_t low, str16 name)'),
    view: kernel.func('void * __stdcall MapViewOfFile(void *mapping, uint32_t access, uint32_t high, uint32_t low, size_t bytes)'),
    unmap: kernel.func('int __stdcall UnmapViewOfFile(void *view)'),
    load: kernel.func('void * __stdcall LoadLibraryW(str16 path)'),
    unload: kernel.func('int __stdcall FreeLibrary(void *module)'),
    modulePath: kernel.func('uint32_t __stdcall GetModuleFileNameW(void *module, _Out_ void *path, uint32_t length)'),
  };
}
function valid(api, handle) { return !!handle && api.koffi.address(handle) !== 0xffffffffffffffffn; }
function probe(api, file) {
  const result = {};
  // OPEN_EXISTING only. Write access is requested to measure image-section conflicts; no bytes are written.
  for (const [name, access] of [['read', 0x80000000], ['readDelete', 0x80010000], ['readWrite', 0xc0000000]]) {
    const handle = api.create(file, access, 0, null, 3, 0x00200000, null);
    if (!valid(api, handle)) result[name] = Number(api.error());
    else { result[name] = 0; assert.notEqual(api.close(handle), 0, 'exclusive_probe_close_failed'); }
  }
  return result;
}
async function holder(kind, file) {
  let release;
  if (kind === 'open') { const fd = openSync(file, 'r'); release = () => closeSync(fd); }
  else {
    const api = native();
    if (kind === 'mapping') {
      const fd = api.create(file, 0x80000000, 7, null, 3, 0x00200000, null); assert.ok(valid(api, fd), 'fixture_mapping_file_open_failed');
      const mapping = api.mapping(fd, null, 2, 0, 0, null); assert.ok(mapping, 'fixture_mapping_failed');
      const view = api.view(mapping, 4, 0, 0, 0); assert.ok(view, 'fixture_mapping_view_failed');
      assert.notEqual(api.close(mapping), 0); assert.notEqual(api.close(fd), 0);
      release = () => assert.notEqual(api.unmap(view), 0);
    } else {
      assert.equal(kind, 'image');
      const module = api.load(file); assert.ok(module, 'fixture_image_load_failed');
      const bytes = Buffer.alloc(65536), length = Number(api.modulePath(module, bytes, bytes.length / 2));
      assert.ok(length > 0 && length < bytes.length / 2, 'fixture_image_path_unreadable');
      assert.equal(bytes.subarray(0, length * 2).toString('utf16le').toLowerCase(), file.toLowerCase(), 'fixture_loaded_image_redirected');
      release = () => assert.notEqual(api.unload(module), 0);
    }
  }
  let released = false;
  const finish = code => { if (!released) { released = true; release(); } process.exit(code); };
  process.once('disconnect', () => finish(1));
  process.once('message', message => { assert.equal(message, 'close'); finish(0); });
  process.send('ready');
}
async function deadline(promise, message, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Qualification only: real open handles, a view with its source handles closed, and a privately copied DLL. */
export async function checkWindowsObjectOwnership(root) {
  const api = native(), file = join(root, 'exclusive-観測.js'), image = join(root, 'caveat-owned-qualification.dll');
  writeFileSync(file, 'owned exclusive-open fixture'); copyFileSync(windowsSystemPath('version.dll'), image);
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const original = [hash(file), hash(image)];
  for (const kind of ['open', 'mapping', 'image']) {
    const path = kind === 'image' ? image : file, normal = probe(api, path);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--hold', kind, path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr.resume();
    let held, released;
    try {
      const ready = await deadline(Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('owned_object_holder_exited'); })]), 'owned_object_holder_ready_deadline');
      assert.equal(ready[0], 'ready'); held = probe(api, path);
      const closed = once(child, 'close'); child.send('close'); await deadline(closed, 'owned_object_holder_close_deadline');
      assert.equal(child.exitCode, 0); released = probe(api, path);
      process.stdout.write('CAVEAT_WINDOWS_OBJECT_PROOF ' + JSON.stringify({ kind, normal, held, released, ownHolderClosed: true,
        identityBoundToOwnedChild: true, existingProcessOperations: 0, productReadiness: 'not-qualified' }) + '\n');
      assert.deepEqual(normal, { read: 0, readDelete: 0, readWrite: 0 }, 'owned_object_normal_not_available');
      assert.deepEqual(released, normal, 'owned_object_did_not_release');
      if (kind === 'open') assert.equal(held.read, 32, 'owned_file_holder_not_detected');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close'); if (child.connected) child.send('close');
        try { await deadline(closed, 'owned_object_cleanup_deadline', 5000); }
        catch { child.kill(); await deadline(closed, 'owned_object_termination_deadline', 5000); }
      }
    }
  }
  assert.deepEqual([hash(file), hash(image)], original, 'owned_object_probe_modified_bytes');
}
if (process.argv[2] === '--hold') await holder(process.argv[3], process.argv[4]);
