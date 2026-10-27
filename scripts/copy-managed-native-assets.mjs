import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const coreRequire = createRequire(join(root, 'packages/core/package.json'));
const version = '3.3.4';
export const nativeTargets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];

/** Keep the managed archive independent of npm's external, mutable dependency tree. */
export function copyManagedNativeAssets() {
  const source = dirname(coreRequire.resolve('koffi'));
  const nativeRequire = createRequire(join(source, 'package.json'));
  const target = join(root, 'apps/cli/dist/native');
  assert.equal(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version, version);
  for (const file of ['package.json', 'index.js', 'LICENSE.txt', 'src/koffi/index.js']) {
    const dest = join(target, 'koffi', file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(source, file), dest);
  }
  for (const name of nativeTargets) {
    const pkg = '@koromix/koffi-' + name;
    const directory = dirname(nativeRequire.resolve(pkg + '/package.json'));
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    assert.equal(metadata.name, pkg); assert.equal(metadata.version, version);
    cpSync(directory, join(target, pkg), { recursive: true, dereference: true });
  }
  // Upstream's static loader searches external node_modules before its relative fallback.
  const loader = join(target, 'koffi/src/koffi/src/static.js');
  mkdirSync(dirname(loader), { recursive: true });
  writeFileSync(loader, `// Product packaging adaptation; upstream MIT license: ../../../LICENSE.txt\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport function loadStatic(pkg) { return require('../../../../@koromix/koffi-' + pkg); }\n`);
}
