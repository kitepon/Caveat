import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MiB = 1024 * 1024;
type Identity = ReturnType<typeof identity>;
export type GlobalTreeRow = Identity & {
  relativePath: string;
  kind: 'file' | 'directory' | 'link' | 'special';
  sha256?: string;
  target?: string;
  fileType?: string;
};
function identity(stat: BigIntStats) {
  return { dev: String(stat.dev), ino: String(stat.ino), uid: Number(stat.uid), gid: Number(stat.gid),
    mode: Number(stat.mode & 0o777n), size: String(stat.size), nlink: String(stat.nlink),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
}
const inside = (root: string, file: string) => {
  const rel = relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

/** Required JSON must be a regular file before open; nonblocking also closes the FIFO replacement race. */
function readRegular(file: string, limit: number, keepBytes: boolean) {
  const before = lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'required_file_nonregular');
  assert.ok(before.size <= BigInt(limit), 'required_file_oversized');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert.ok(opened.isFile(), 'required_file_nonregular');
    assert.deepEqual(identity(opened), identity(before), 'required_file_changed');
    const hash = createHash('sha256'), chunks: Buffer[] = [], buffer = Buffer.alloc(Math.min(limit + 1, MiB));
    let count = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, limit - count + 1), null);
      if (!n) break;
      count += n;
      assert.ok(count <= limit, 'required_file_oversized');
      hash.update(buffer.subarray(0, n));
      if (keepBytes) chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    assert.deepEqual(identity(fstatSync(fd, { bigint: true })), identity(opened), 'required_file_changed');
    assert.deepEqual(identity(lstatSync(file, { bigint: true })), identity(opened), 'required_file_changed');
    return { bytes: keepBytes ? Buffer.concat(chunks) : Buffer.alloc(0), sha256: hash.digest('hex'), identity: identity(opened) };
  } finally { closeSync(fd); }
}

export function readGlobalPackageJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readRegular(file, MiB, true).bytes.toString('utf8'));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'package_json_object_required');
  return value as Record<string, unknown>;
}

/** Observation permits shared/special objects; a mutation snapshot rejects both. Links are never followed. */
export function snapshotGlobalTree(root: string, options: {
  observeOnly?: boolean; opaqueExternalLinks?: boolean; skip?: string[]; maxBytes?: number;
} = {}): GlobalTreeRow[] {
  assert.ok(isAbsolute(root), 'absolute_tree_root_required');
  root = resolve(root);
  const rows: GlobalTreeRow[] = [], skipped = new Set(options.skip ?? []);
  const limit = options.maxBytes ?? 128 * MiB;
  let total = 0;
  function visit(file: string) {
    const relativePath = relative(root, file);
    if (skipped.has(relativePath)) return;
    assert.ok(rows.length < 100000, 'tree_file_bound');
    const before = lstatSync(file, { bigint: true });
    const row: GlobalTreeRow = { relativePath, ...identity(before), kind: 'special' };
    if (before.isSymbolicLink()) {
      row.kind = 'link'; row.target = readlinkSync(file);
      assert.ok(options.opaqueExternalLinks || !isAbsolute(row.target) && inside(root, resolve(dirname(file), row.target)), 'external_or_absolute_link');
    } else if (before.isDirectory()) {
      row.kind = 'directory';
    } else {
      assert.ok(options.observeOnly || before.isFile() && before.nlink === 1n, 'nonregular_or_shared_file');
      if (before.isFile()) {
        row.kind = 'file'; total += Number(before.size);
        assert.ok(total <= limit, 'tree_byte_bound');
        const read = readRegular(file, limit - total + Number(before.size), false);
        assert.deepEqual(read.identity, identity(before), 'tree_changed_during_read');
        row.sha256 = read.sha256;
      } else row.fileType = String(before.mode & 0o170000n);
    }
    rows.push(row);
    if (row.kind === 'directory') {
      for (const name of readdirSync(file).sort()) visit(join(file, name));
    }
    assert.deepEqual(identity(lstatSync(file, { bigint: true })), identity(before), 'tree_changed_during_read');
  }
  visit(root);
  return rows;
}

export type GlobalPackageSnapshotInput = {
  packageRoot: string; globalRoot: string; expectedPackageVersion: string;
  node: string; nodeVersion: string; npmAlias: string;
  pointer: string; expectedRelease: string;
  protectedFiles: string[]; pins: { file: string; sha256: string }[];
};
function dependencyNames(value: unknown) {
  if (value === undefined) return [];
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'invalid_dependencies');
  return Object.keys(value).map(name => {
    assert.ok(/^(?:@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9._~-]+$/.test(name) && !['.', '..'].includes(name), 'unsafe_dependency_name');
    return name;
  });
}

/** Package integrity alone never grants write permission or establishes process/writer absence. */
export function snapshotGlobalPackage(input: GlobalPackageSnapshotInput) {
  const observed = (file: string, maxBytes?: number) => snapshotGlobalTree(file, { observeOnly: true, maxBytes });
  let phase = 'runtime_binding';
  try {
    assert.equal(realpathSync(input.node), realpathSync(process.execPath), 'runtime_path_changed');
    assert.equal(process.version, input.nodeVersion, 'runtime_version_changed');
    const node = realpathSync(input.node), nodeTree = observed(node, 256 * MiB);
    const packageRoot = resolve(input.packageRoot), globalRoot = resolve(input.globalRoot);
    assert.equal(dirname(packageRoot), globalRoot, 'package_not_direct_global_child');
    assert.equal(basename(packageRoot), 'caveat-cli');
    phase = 'package_tree';
    const packageTree = observed(packageRoot);
    assert.equal(packageTree[0]?.kind, 'directory', 'package_root_redirect');
    const pkg = readGlobalPackageJson(join(packageRoot, 'package.json'));
    assert.equal(pkg.name, 'caveat-cli');
    assert.equal(pkg.version, input.expectedPackageVersion, 'unexpected_old_global');
    phase = 'dependency_closure';
    const dependencies: { from: string; name: string; manifest: string }[] = [], seen = new Set<string>();
    function visit(manifest: string) {
      if (seen.has(manifest)) return;
      seen.add(manifest);
      const doc = readGlobalPackageJson(manifest);
      for (const name of new Set([...dependencyNames(doc.dependencies), ...dependencyNames(doc.optionalDependencies)])) {
        let directory = dirname(manifest), found: string | undefined;
        for (;;) {
          const candidate = join(directory, 'node_modules', name, 'package.json');
          try { lstatSync(candidate); found = candidate; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (directory === packageRoot) break;
          directory = dirname(directory);
          assert.ok(directory === packageRoot || inside(packageRoot, directory), 'dependency_outside_retained_package');
        }
        assert.ok(found, 'dependency_outside_retained_package');
        assert.ok(inside(packageRoot, realpathSync(found)), 'dependency_redirect');
        dependencies.push({ from: relative(packageRoot, manifest), name, manifest: relative(packageRoot, found) });
        visit(found);
      }
    }
    visit(join(packageRoot, 'package.json'));
    phase = 'protected_deployment';
    const protectedFiles = input.protectedFiles.map(file => ({ file, rows: observed(file, 256 * MiB) }));
    for (const file of protectedFiles) assert.equal(file.rows[0]?.kind, 'file', 'protected_file_redirect');
    for (const pin of input.pins) {
      assert.match(pin.sha256, /^[a-f0-9]{64}$/);
      const file = protectedFiles.find(row => row.file === pin.file);
      assert.ok(file, 'protected_pin_not_captured');
      assert.equal(file.rows[0]?.sha256, pin.sha256, 'protected_pin_changed');
    }
    assert.equal(readGlobalPackageJson(input.pointer).release, input.expectedRelease, 'deployment_release_changed');
    phase = 'npm_tree';
    const npm = realpathSync(input.npmAlias), npmRoot = dirname(dirname(npm));
    const npmPackage = readGlobalPackageJson(join(npmRoot, 'package.json'));
    assert.equal(npmPackage.name, 'npm');
    const npmTree = snapshotGlobalTree(npmRoot, { observeOnly: true, opaqueExternalLinks: true });
    phase = 'npm_management';
    const management = join(globalRoot, '.package-lock.json');
    let npmManagement: { path: string; rows?: GlobalTreeRow[]; absent?: true };
    try {
      const rows = observed(management, 8 * MiB);
      assert.equal(rows[0]?.kind, 'file', 'management_file_nonregular');
      npmManagement = { path: management, rows };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      npmManagement = { path: management, absent: true };
    }
    phase = 'other_globals';
    const otherGlobals = snapshotGlobalTree(globalRoot, {
      observeOnly: true, skip: ['caveat-cli', '.package-lock.json'], opaqueExternalLinks: true,
    }).filter(row => row.relativePath !== '');
    phase = 'final_identity';
    assert.deepEqual(observed(packageRoot), packageTree, 'package_changed_during_read');
    for (const file of protectedFiles) assert.deepEqual(observed(file.file, 256 * MiB), file.rows, 'protected_changed_during_read');
    assert.deepEqual(observed(node, 256 * MiB), nodeTree, 'runtime_changed_during_read');
    assert.deepEqual(snapshotGlobalTree(npmRoot, { observeOnly: true, opaqueExternalLinks: true }), npmTree, 'npm_changed_during_read');
    assert.deepEqual(snapshotGlobalTree(globalRoot, { observeOnly: true, skip: ['caveat-cli', '.package-lock.json'], opaqueExternalLinks: true }).filter(row => row.relativePath !== ''), otherGlobals, 'other_global_changed_during_read');
    try {
      const current = observed(management, 8 * MiB);
      assert.ok(!npmManagement.absent, 'management_created_during_read');
      assert.deepEqual(current, npmManagement.rows, 'management_changed_during_read');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !npmManagement.absent) throw error;
    }
    return { schema: 'caveat.global_package_snapshot.v1' as const, status: 'consistent' as const,
      packageRoot, packageVersion: pkg.version, packageTree, dependencies, reachableManifests: seen.size,
      protectedFiles, node: { alias: input.node, canonical: node, version: process.version, binary: nodeTree },
      npm: { executable: npm, version: npmPackage.version, tree: npmTree }, npmManagement, otherGlobals,
      filesystemWrites: 0, childProcesses: 0, writePermission: false as const, processAssessment: 'not-performed' as const };
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { snapshotPhase: phase });
    throw error;
  }
}
