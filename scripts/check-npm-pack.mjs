#!/usr/bin/env node
import { spawnCommandSync } from './process-command.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repoRoot, 'apps', 'cli');
const tempDir = mkdtempSync(join(tmpdir(), 'caveat-npm-pack-'));

try {
  const tarball = packCli(tempDir);
  const entries = readTarball(tarball);
  const manifestEntry = entries.get('package/package.json');
  if (!manifestEntry) throw new Error('packed tarball does not contain package/package.json');

  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  assertEqual(manifest.name, 'caveat-cli', 'manifest.name');
  assertEqual(manifest.bin?.caveat, 'dist/caveat.js', 'manifest.bin.caveat');
  assertEqual(manifest.dependencies?.commander, '^14.0.3', 'manifest.dependencies.commander');
  if (manifest.dependencies?.['@caveat/core'] || manifest.dependencies?.['@caveat/mcp'] || manifest.dependencies?.['@caveat/web']) {
    throw new Error('workspace packages leaked into published dependencies');
  }

  const workspaceLeaks = findWorkspaceProtocol(manifest);
  if (workspaceLeaks.length > 0) {
    throw new Error(`workspace protocol leaked into packed manifest: ${workspaceLeaks.join(', ')}`);
  }

  const caveatBin = entries.get('package/dist/caveat.js');
  if (!caveatBin) throw new Error('packed tarball does not contain package/dist/caveat.js');
  if ((caveatBin.mode & 0o111) === 0) {
    throw new Error(`package/dist/caveat.js is not executable in tarball mode ${caveatBin.mode.toString(8)}`);
  }

  const requiredFiles = [
    'package/README.md',
    'package/LICENSE',
    'package/dist/index.js',
    'package/dist/schema.sql',
  ];
  for (const file of requiredFiles) {
    if (!entries.has(file)) throw new Error(`packed tarball missing ${file}`);
  }

  const installedVersion = installAndReadVersion(tarball, manifest.version);

  process.stdout.write(
    JSON.stringify(
      {
        status: 'ok',
        tarball: basename(tarball),
        package: manifest.name,
        version: manifest.version,
        installedVersion,
        bin: manifest.bin,
        dependencyCount: Object.keys(manifest.dependencies ?? {}).length,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function packCli(packDestination) {
  const result = spawnCommandSync(corepackCommand(), ['pnpm', 'pack', '--pack-destination', packDestination, '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm pack failed with status ${result.status}`);

  const packResult = JSON.parse(result.stdout);
  if (!packResult.filename) throw new Error('pnpm pack did not report a filename');
  return resolve(packResult.filename);
}

function installAndReadVersion(tarball, expectedVersion) {
  const prefix = join(tempDir, 'npm-prefix');
  const install = spawnCommandSync(
    npmCommand(),
    [
      'install',
      '--global',
      tarball,
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (install.stderr) process.stderr.write(install.stderr);
  if (install.error) throw install.error;
  if (install.status !== 0) {
    throw new Error(`npm install -g packed tarball failed with status ${install.status}: ${install.stdout}`);
  }

  const caveat = process.platform === 'win32' ? join(prefix, 'caveat.cmd') : join(prefix, 'bin', 'caveat');
  const version = spawnCommandSync(caveat, ['--version'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (version.stderr) process.stderr.write(version.stderr);
  if (version.error) throw version.error;
  if (version.status !== 0) {
    throw new Error(`installed caveat --version failed with status ${version.status}: ${version.stdout}`);
  }

  const actualVersion = version.stdout.trim();
  assertEqual(actualVersion, expectedVersion, 'installed caveat --version');
  return actualVersion;
}

function readTarball(path) {
  const tar = gunzipSync(readFileSync(path));
  const entries = new Map();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = readTarString(header, 124, 12).trim();
    const modeText = readTarString(header, 100, 8).trim();
    const size = parseInt(sizeText, 8);
    const mode = parseInt(modeText, 8);
    if (!Number.isFinite(size)) throw new Error(`invalid tar size for ${fullName}`);
    if (!Number.isFinite(mode)) throw new Error(`invalid tar mode for ${fullName}`);

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    entries.set(fullName, {
      data: tar.subarray(dataStart, dataEnd),
      mode,
    });

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

function readTarString(buffer, start, length) {
  const end = start + length;
  const nul = buffer.indexOf(0, start);
  const sliceEnd = nul === -1 || nul > end ? end : nul;
  return buffer.subarray(start, sliceEnd).toString('utf8');
}

function findWorkspaceProtocol(value, path = '$') {
  if (typeof value === 'string') {
    return value.startsWith('workspace:') ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findWorkspaceProtocol(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) => findWorkspaceProtocol(nested, `${path}.${key}`));
  }
  return [];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function corepackCommand() {
  return process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
