import { readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function copyPrivateEvidenceAssets() {
  const cli = join(root, 'apps/cli');
  const pkg = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'));
  const source = join(cli, 'src/contracts/factory-private-evidence');
  const target = join(cli, 'dist/factory-private-evidence');
  mkdirSync(target, { recursive: true });
  for (const name of ['capability.v1.schema.json', 'private-frame.v1.schema.json', 'windows-channel.v1.schema.json'])
    copyFileSync(join(source, name), join(target, name));
  // No OS transport is implemented or verified. Empty means no private requests may be sent.
  writeFileSync(join(cli, 'dist/factory-private-evidence-capabilities.v1.json'), JSON.stringify({
    schema: 'caveat.factory_private_evidence_capability.v1', product: 'caveat', package_version: pkg.version,
    public_diagnostic_schema: 'caveat.native_factory_diagnostics.v1', private_protocol: 'caveat.factory_private_evidence.v1',
    transports: [], max_channel_bytes: 16384, operation_receipt: 'not_supported',
  }, null, 2) + '\n');
}
