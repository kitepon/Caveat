import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from '../apps/cli/node_modules/ajv/dist/2020.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tarball = process.argv[2];
if (!tarball) throw new Error('usage: node scripts/check-private-evidence-pack.mjs <local-tarball>');
// Read packed bytes only; do not install or run the CLI/diagnostics.
const entries = new Set(execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n'));
const read = path => execFileSync('tar', ['-xOzf', tarball, path], { maxBuffer: 32 * 1024 * 1024 });
const requireEntry = path => { if (!entries.has(path)) throw new Error('missing packed entry: ' + path); };
const pkg = JSON.parse(read('package/package.json'));
const sourcePkg = JSON.parse(readFileSync(join(root, 'apps/cli/package.json')));
if (pkg.name !== 'caveat-cli' || pkg.version !== sourcePkg.version || pkg.bin?.caveat !== 'dist/caveat.js')
  throw new Error('package version/bin mismatch');
for (const name of ['caveat.js', 'index.js', 'privateEvidence/validation.js', 'privateEvidence/origin.js', 'privateEvidence/candidate.js', 'factory-private-evidence-capabilities.v1.json'])
  requireEntry('package/dist/' + name);
const cap = JSON.parse(read('package/dist/factory-private-evidence-capabilities.v1.json'));
if (cap.package_version !== pkg.version || cap.transports.length !== 0 || cap.operation_receipt !== 'not_supported')
  throw new Error('capability mismatch or unverified transport declared');
const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const name of ['capability.v1.schema.json', 'private-frame.v1.schema.json', 'windows-channel.v1.schema.json']) {
  const entry = 'package/dist/factory-private-evidence/' + name; requireEntry(entry);
  const packed = read(entry), source = readFileSync(join(root, 'apps/cli/src/contracts/factory-private-evidence', name));
  if (!packed.equals(source)) throw new Error('packed schema bytes differ: ' + name);
  const validate = ajv.compile(JSON.parse(packed));
  if (name === 'capability.v1.schema.json' && !validate(cap)) throw new Error('packed capability invalid');
}
console.log(JSON.stringify({ status: 'pass', package_version: pkg.version, bin: pkg.bin.caveat,
  transports: cap.transports, tarball_sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
  entry_executed: false, installation_performed: false }));
