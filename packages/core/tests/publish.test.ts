import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  buildSealedReadme,
  collectPublishSet,
  publishOwn,
  verifySealedMirror,
} from '../src/publish.js';
import type { PublishFile } from '../src/publish.js';
import { PublishScanError, publishSelfIdentityTokens } from '../src/publishScan.js';
import { sealBundle, unsealBundle } from '../src/sealedBundle.js';
import type { CaveatConfig } from '../src/config.js';
import type { Logger } from '../src/db.js';

const CONTENT_KEY = Buffer.alloc(32, 3);
const OTHER_KEY = Buffer.alloc(32, 9);
const alwaysYes = () => true;

// publishOwn commits inside the mirror clone it creates, which has no local
// git identity. CI runners have no global identity either — inject one via
// env so every git child (execFileSync and simple-git) inherits it.
process.env.GIT_AUTHOR_NAME = 'caveat test';
process.env.GIT_AUTHOR_EMAIL = 'caveat-test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'caveat test';
process.env.GIT_COMMITTER_EMAIL = 'caveat-test@example.invalid';

interface KeyServer {
  url: string;
  close: () => Promise<void>;
}

interface Fixture {
  root: string;
  remote: string;
  caveatHome: string;
  knowledgeRepo: string;
  entriesDir: string;
  mirrorDir: string;
  config: CaveatConfig;
  keyServer: KeyServer;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function startKeyServer(keys: Map<string, Buffer>): Promise<KeyServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const prefix = '/v1/keys/';
    if (req.method !== 'GET' || !url.pathname.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const id = decodeURIComponent(url.pathname.slice(prefix.length));
    const key = keys.get(id);
    if (!key) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing key' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keyId: id, key: key.toString('base64') }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('unexpected server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function entry(id: string, visibility: string, body = 'symptom text', showcase?: boolean): string {
  const showcaseLine = showcase === undefined ? '' : `showcase: ${showcase ? 'true' : 'false'}\n`;
  return `---\nid: ${id}\ntitle: ${id}\nvisibility: ${visibility}\n${showcaseLine}confidence: tentative\n---\n\n## Symptom\n${body}\n`;
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'caveat-publish-'));
  const remote = join(root, 'remote.git');
  git(['init', '--bare', remote]);
  const caveatHome = join(root, 'home');
  const knowledgeRepo = join(root, 'own');
  const entriesDir = join(knowledgeRepo, 'entries');
  mkdirSync(entriesDir, { recursive: true });
  const keyServer = await startKeyServer(new Map([['v1', CONTENT_KEY]]));
  return {
    root,
    remote,
    caveatHome,
    knowledgeRepo,
    entriesDir,
    mirrorDir: join(caveatHome, 'publish', 'mirror'),
    keyServer,
    config: {
      knowledgeRepo: 'own',
      semverKeys: [],
      publishTarget: remote,
      sealedKeyId: 'v1',
      sealedKeyserverUrl: keyServer.url,
      runtimeErrors: false,
    },
  };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const d of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, d.name);
      if (d.name === '.git') continue;
      if (d.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

function cloneMirrorBack(): string {
  const check = join(fixture.root, `verify-clone-${Math.random().toString(16).slice(2)}`);
  git(['clone', fixture.remote, check]);
  if (!existsSync(join(check, 'README.md'))) {
    const branch = git(['branch', '-r'], check).split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('origin/') && line !== 'origin/HEAD');
    if (branch) git(['checkout', '-t', branch], check);
  }
  return check;
}

function mirrorFiles(clone: string): string[] {
  return walkFiles(clone).map((p) => relative(clone, p).replace(/\\/g, '/')).sort();
}

function publishArgs(logger: Logger = silentLogger) {
  return {
    paths: { caveatHome: fixture.caveatHome, knowledgeRepo: fixture.knowledgeRepo, entriesDir: fixture.entriesDir, publishMirrorDir: fixture.mirrorDir },
    config: fixture.config,
    logger,
    confirmImpl: alwaysYes,
    isTty: () => false,
    yes: true,
  };
}

function captureLogger(): { logger: Logger; info: string[]; warn: string[]; error: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  return {
    info,
    warn,
    error,
    logger: {
      info: (msg) => info.push(msg),
      warn: (msg) => warn.push(msg),
      error: (msg) => error.push(msg),
    },
  };
}

function seedRemoteWithBundle(bundle: Buffer, readme = '# Seed\n'): void {
  const seed = join(fixture.root, `seed-${Math.random().toString(16).slice(2)}`);
  git(['clone', fixture.remote, seed]);
  mkdirSync(join(seed, 'bundle'), { recursive: true });
  writeFileSync(join(seed, 'README.md'), readme, 'utf-8');
  writeFileSync(join(seed, 'bundle', 'entries.caveat'), bundle);
  git(['add', '-A'], seed);
  git(['commit', '-m', 'seed sealed bundle'], seed);
  git(['push', 'origin', 'HEAD'], seed);
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// Real git subprocess chains (clone/fetch/reset/clean/commit/push × 2 per
// test) exceed vitest's 5s default on the slowest Windows CI runner.
const GIT_TEST_TIMEOUT_MS = 60_000;

let fixture: Fixture;
beforeEach(async () => { fixture = await makeFixture(); });
afterEach(async () => {
  await fixture.keyServer.close();
  // maxRetries: Windows can report EBUSY on rmdir while a git child releases handles.
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('collectPublishSet', () => {
  it('returns public entries with showcase flags and lists every invalid one', () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'show it', true));
    mkdirSync(join(fixture.entriesDir, 'cat'), { recursive: true });
    writeFileSync(join(fixture.entriesDir, 'cat', 'b.md'), entry('b', 'private', 'secret repo detail'));
    writeFileSync(join(fixture.entriesDir, 'c.md'), entry('c', 'Public')); // typo -> invalid
    writeFileSync(join(fixture.entriesDir, 'd.md'), '---\nid: d\nvisibility: [broken\n');

    const set = collectPublishSet(fixture.entriesDir);
    expect(set.files.map((f) => ({ relPath: f.relPath, showcase: f.showcase }))).toEqual([{ relPath: 'a.md', showcase: true }]);
    expect(set.invalid.map((x) => x.relPath).sort()).toEqual(['c.md', 'd.md']);
  });
});

describe('buildSealedReadme', () => {
  it('orders showcase entries by UTF-8 byte order, not locale-dependent localeCompare', () => {
    const files: PublishFile[] = [
      { relPath: 'zeta.md', content: Buffer.from(entry('zeta', 'public', 'zeta body', true)), showcase: true },
      { relPath: 'alpha/beta.md', content: Buffer.from(entry('beta', 'public', 'beta body', true)), showcase: true },
    ];
    const readme = buildSealedReadme(files.length, files);
    const alphaIndex = readme.indexOf('### alpha/beta.md');
    const zetaIndex = readme.indexOf('### zeta.md');
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(zetaIndex).toBeGreaterThan(-1);
    expect(alphaIndex).toBeLessThan(zetaIndex);
  });
});

describe('publishOwn (sealed local bare mirror)', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('keeps the legacy public paths shape without requiring knowledgeRepo', async () => {
    writeFileSync(join(fixture.entriesDir, 'legacy.md'), entry('legacy', 'public', 'legacy paths shape'));
    const result = await publishOwn({
      ...publishArgs(),
      paths: {
        caveatHome: fixture.caveatHome,
        entriesDir: fixture.entriesDir,
        publishMirrorDir: fixture.mirrorDir,
      },
    });
    expect(result).toMatchObject({ changed: true, fileCount: 1 });
  });

  it('publishes only README.md and bundle/entries.caveat without plaintext non-showcase bytes or history', async () => {
    writeFileSync(join(fixture.entriesDir, 'pub.md'), entry('pub', 'public', 'public nonshowcase unique text'));
    writeFileSync(join(fixture.entriesDir, 'show.md'), entry('show', 'public', 'showcase plaintext unique text', true));
    mkdirSync(join(fixture.entriesDir, 'secret'), { recursive: true });
    writeFileSync(join(fixture.entriesDir, 'secret', 'priv.md'), entry('priv', 'private', 'confidential internal token'));

    const result = await publishOwn(publishArgs());
    expect(result).toMatchObject({ changed: true, fileCount: 2, dryRun: false });

    const clone = cloneMirrorBack();
    expect(mirrorFiles(clone)).toEqual(['README.md', 'bundle/entries.caveat']);
    const readme = readFileSync(join(clone, 'README.md'), 'utf-8');
    const bundle = readFileSync(join(clone, 'bundle', 'entries.caveat'));
    expect(readme).not.toContain('public nonshowcase unique text');
    expect(readme).not.toContain('confidential internal token');
    expect(bundle.includes(Buffer.from('public nonshowcase unique text'))).toBe(false);
    expect(bundle.includes(Buffer.from('confidential internal token'))).toBe(false);
    expect(readme).toContain('showcase plaintext unique text');
    // non-showcase エントリの relPath / 拡張子抜きスラッグ自体もメタデータとして漏れて
    // はいけない (旧 Categories 行の漏洩と同じ形の再発防止)。'pub' は word-boundary で
    // 判定する — 'Public'/'publish' 等の README 定型句と部分一致してしまうため。
    expect(readme).not.toContain('pub.md');
    expect(readme).not.toMatch(/\bpub\b/i);
    expect(git(['rev-list', '--count', 'HEAD'], clone).trim()).toBe('1');
  });

  it('returns no-op on the second publish and keeps commit count unchanged', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'NOOP-PLAINTEXT'));
    await publishOwn(publishArgs());
    const clone1 = cloneMirrorBack();
    const count1 = git(['rev-list', '--count', 'HEAD'], clone1).trim();

    const logger = captureLogger();
    const second = await publishOwn(publishArgs(logger.logger));
    expect(second.changed).toBe(false);
    expect(logger.info).toContain('no changes to publish');

    const clone2 = cloneMirrorBack();
    expect(git(['rev-list', '--count', 'HEAD'], clone2).trim()).toBe(count1);
  });

  it('logs M for entry edits and keeps the pushed branch to one commit', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'before'));
    await publishOwn(publishArgs());

    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'after'));
    const logger = captureLogger();
    const result = await publishOwn(publishArgs(logger.logger));

    expect(result.changed).toBe(true);
    expect(logger.info).toContain('M a.md');
    const clone = cloneMirrorBack();
    expect(git(['rev-list', '--count', 'HEAD'], clone).trim()).toBe('1');
  });

  it('re-pushes unchanged content after the bare remote is recreated empty', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'REMOTE-RECREATE'));
    await publishOwn(publishArgs());

    rmSync(fixture.remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    git(['init', '--bare', fixture.remote]);

    const logger = captureLogger();
    const result = await publishOwn(publishArgs(logger.logger));
    expect(result.changed).toBe(true);
    expect(logger.info).toContain('remote branch differs or is missing; sealed mirror will be pushed');

    const clone = cloneMirrorBack();
    expect(mirrorFiles(clone)).toEqual(['README.md', 'bundle/entries.caveat']);
  });

  it('re-pushes unchanged content after the bare remote is recreated empty following a non-empty clone lineage (dangling origin/HEAD)', async () => {
    // 空 bare remote への直 clone は origin/HEAD symref を持たない（上の「recreated
    // empty」テストは一度もこの経路を通らない）。symref が dangling 化するバグは、
    // 非空 remote から一度 clone してミラーが symref を獲得した後に remote が空へ
    // 作り直される系譜でしか再現しないため、まず remote に実コンテンツを push する。
    seedRemoteWithBundle(Buffer.from('seed-bundle-bytes'), '# Seed\n');

    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'dangling head recovery'));
    await publishOwn(publishArgs());
    const clone1 = cloneMirrorBack();
    expect(git(['rev-list', '--count', 'HEAD'], clone1).trim()).toBe('1');

    // remote を空で作り直す。次の publish の fetch --prune が origin/<branch> を消し、
    // origin/HEAD symref だけが参照先を失って残る (dangling) — 修正前はここで
    // preparePublishMirror の reset --hard が unknown revision で毎回 throw していた。
    rmSync(fixture.remote, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    git(['init', '--bare', fixture.remote]);

    const result = await publishOwn(publishArgs());
    expect(result.changed).toBe(true);

    const clone2 = cloneMirrorBack();
    expect(mirrorFiles(clone2)).toEqual(['README.md', 'bundle/entries.caveat']);
    expect(git(['rev-list', '--count', 'HEAD'], clone2).trim()).toBe('1');
  });

  it('prints showcase entries in README and omits entries without showcase: true', async () => {
    writeFileSync(join(fixture.entriesDir, 'show.md'), entry('show', 'public', 'SHOWCASE-BODY-FULL', true));
    writeFileSync(join(fixture.entriesDir, 'plain.md'), entry('plain', 'public', 'PLAIN-BODY-HIDDEN'));
    await publishOwn(publishArgs());

    const clone = cloneMirrorBack();
    const readme = readFileSync(join(clone, 'README.md'), 'utf-8');
    expect(readme).toContain('SHOWCASE-BODY-FULL');
    expect(readme).not.toContain('PLAIN-BODY-HIDDEN');
  });

  it('aborts entirely when any entry has invalid visibility', async () => {
    writeFileSync(join(fixture.entriesDir, 'ok.md'), entry('ok', 'public'));
    writeFileSync(join(fixture.entriesDir, 'bad.md'), entry('bad', 'Public')); // capitalized typo -> invalid
    await expect(publishOwn(publishArgs())).rejects.toThrow(/invalid entries/i);

    const clone = cloneMirrorBack();
    expect(mirrorFiles(clone)).toEqual([]);
  });

  it('aborts before mirror work when a public entry contains self identity', async () => {
    const token = [...publishSelfIdentityTokens()][0];
    expect(token).toBeDefined();
    writeFileSync(join(fixture.entriesDir, 'leak.md'), entry('leak', 'public', `ssh ${token}@server`));
    await expect(publishOwn(publishArgs())).rejects.toBeInstanceOf(PublishScanError);
    expect(existsSync(fixture.mirrorDir)).toBe(false);
  });

  it('warns and shows all entries as added when the previous bundle cannot be decrypted', async () => {
    const badBundle = sealBundle({
      files: [{ relPath: 'old.md', content: Buffer.from(entry('old', 'public', 'old')) }],
      contentKey: OTHER_KEY,
      keyId: 'keyserver:old',
      keyserverUrl: 'http://127.0.0.1:9',
    });
    seedRemoteWithBundle(badBundle);
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'fresh'));

    const logger = captureLogger();
    const result = await publishOwn(publishArgs(logger.logger));

    expect(result.changed).toBe(true);
    expect(logger.warn.some((line) => line.includes('previous sealed bundle could not be decrypted'))).toBe(true);
    expect(logger.info).toContain('A a.md');
    const clone = cloneMirrorBack();
    expect(git(['rev-list', '--count', 'HEAD'], clone).trim()).toBe('1');
  });

  it('throws an explicit error when sealedKeyserverUrl is not configured', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public'));
    await expect(publishOwn({
      ...publishArgs(),
      config: { ...fixture.config, sealedKeyserverUrl: null },
    })).rejects.toThrow(/sealedKeyserverUrl is not configured.*keyserver.*docs\/archive\/07/i);
  });

  it('normalizes keyserverUrl before sealing so a trailing-slash-only config diff stays a no-op', async () => {
    // 端末 A/B の ~/.caveatrc.json が keyserverUrl の trailing slash だけ違う場合、正規化
    // せずに bundle header へ埋め込むとバイト列が乖離し、内容不変でも changed 判定されて
    // 相互に re-push し合う ping-pong を起こす。normalizeKeyserverUrl を seal 前に通せば
    // 2 回目の publish は no-op のまま。
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'URL-NORMALIZE'));
    await publishOwn(publishArgs());
    const clone1 = cloneMirrorBack();
    const count1 = git(['rev-list', '--count', 'HEAD'], clone1).trim();

    const trailingSlashConfig = { ...fixture.config, sealedKeyserverUrl: `${fixture.keyServer.url}/` };
    const logger = captureLogger();
    const second = await publishOwn({ ...publishArgs(logger.logger), config: trailingSlashConfig });
    expect(second.changed).toBe(false);
    expect(logger.info).toContain('no changes to publish');

    const clone2 = cloneMirrorBack();
    expect(git(['rev-list', '--count', 'HEAD'], clone2).trim()).toBe(count1);
  });

  it('dry-run logs diffs but does not commit or push', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'before'));
    await publishOwn(publishArgs());
    const clone1 = cloneMirrorBack();
    const beforeBundle = readFileSync(join(clone1, 'bundle', 'entries.caveat'));

    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'after'));
    const logger = captureLogger();
    const result = await publishOwn({ ...publishArgs(logger.logger), dryRun: true });

    expect(result).toMatchObject({ changed: true, dryRun: true });
    expect(logger.info).toContain('M a.md');
    const clone2 = cloneMirrorBack();
    expect(readFileSync(join(clone2, 'bundle', 'entries.caveat')).equals(beforeBundle)).toBe(true);
    expect(git(['rev-list', '--count', 'HEAD'], clone2).trim()).toBe('1');
  });

  it('rejects a mirror workdir pointing at a different target', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public'));
    await publishOwn(publishArgs());
    const otherRemote = join(fixture.root, 'other.git');
    git(['init', '--bare', otherRemote]);
    await expect(publishOwn({ ...publishArgs(), config: { ...fixture.config, publishTarget: otherRemote } }))
      .rejects.toThrow(/mirror points at/i);
  });

  it('recovers from a crashed publish that left the mirror workdir on caveat-publish-tmp', async () => {
    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'before-crash'));
    await publishOwn(publishArgs());
    const cloneBefore = cloneMirrorBack();
    const originalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cloneBefore).trim();

    // Simulate a crash right after checkoutOrphan left the mirror workdir
    // checked out on the tmp branch (e.g. verifySealedMirror threw, or the
    // process was killed mid-publish).
    git(['checkout', '-b', 'caveat-publish-tmp'], fixture.mirrorDir);

    writeFileSync(join(fixture.entriesDir, 'a.md'), entry('a', 'public', 'after crash recovery'));
    const result = await publishOwn(publishArgs());
    expect(result.changed).toBe(true);

    const cloneAfter = cloneMirrorBack();
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], cloneAfter).trim()).toBe(originalBranch);
    expect(git(['rev-list', '--count', 'HEAD'], cloneAfter).trim()).toBe('1');
    const bundle = readFileSync(join(cloneAfter, 'bundle', 'entries.caveat'));
    const unsealed = unsealBundle(bundle, CONTENT_KEY);
    const changed = unsealed.files.find((f) => f.relPath === 'a.md');
    expect(changed?.content.toString('utf-8')).toContain('after crash recovery');
  });
});

describe('verifySealedMirror', () => {
  it('throws if the sealed mirror tree has extra files or a private entry', () => {
    const dir = join(fixture.root, 'mirror-check');
    const goodBundle = sealBundle({
      files: [{ relPath: 'ok.md', content: Buffer.from(entry('ok', 'public')) }],
      contentKey: CONTENT_KEY,
      keyId: 'keyserver:v1',
      keyserverUrl: fixture.keyServer.url,
    });
    mkdirSync(join(dir, 'bundle'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'readme', 'utf-8');
    writeFileSync(join(dir, 'bundle', 'entries.caveat'), goodBundle);
    expect(verifySealedMirror({ mirrorDir: dir, bundle: goodBundle, contentKey: CONTENT_KEY, expectedFileCount: 1, readme: 'readme' }).fileCount).toBe(1);

    writeFileSync(join(dir, 'extra.txt'), 'nope', 'utf-8');
    expect(() => verifySealedMirror({ mirrorDir: dir, bundle: goodBundle, contentKey: CONTENT_KEY, expectedFileCount: 1, readme: 'readme' })).toThrow(/verification failed/i);
    rmSync(join(dir, 'extra.txt'));

    const privateBundle = sealBundle({
      files: [{ relPath: 'leak.md', content: Buffer.from(entry('leak', 'private')) }],
      contentKey: CONTENT_KEY,
      keyId: 'keyserver:v1',
      keyserverUrl: fixture.keyServer.url,
    });
    writeFileSync(join(dir, 'bundle', 'entries.caveat'), privateBundle);
    expect(() => verifySealedMirror({ mirrorDir: dir, bundle: privateBundle, contentKey: CONTENT_KEY, expectedFileCount: 1, readme: 'readme' })).toThrow(/visibility is private/i);
  });

  it('throws if README.md content changed after generation', () => {
    const dir = join(fixture.root, 'mirror-readme-check');
    const goodBundle = sealBundle({
      files: [{ relPath: 'ok.md', content: Buffer.from(entry('ok', 'public')) }],
      contentKey: CONTENT_KEY,
      keyId: 'keyserver:v1',
      keyserverUrl: fixture.keyServer.url,
    });
    mkdirSync(join(dir, 'bundle'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'on-disk-readme', 'utf-8');
    writeFileSync(join(dir, 'bundle', 'entries.caveat'), goodBundle);
    expect(() => verifySealedMirror({ mirrorDir: dir, bundle: goodBundle, contentKey: CONTENT_KEY, expectedFileCount: 1, readme: 'expected-readme' }))
      .toThrow(/README\.md content changed/i);
  });
});
