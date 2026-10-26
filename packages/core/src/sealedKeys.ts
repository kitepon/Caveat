import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const SEALED_KEY_FETCH_TIMEOUT_MS = 10_000;

const CONTENT_KEY_BYTES = 32;
const KEY_ID_PREFIX = 'keyserver:';

export interface ContentKeyProvider {
  /**
   * Synchronous by design: the indexing pipeline stays synchronous after callers
   * prewarm all needed keys with ensureKeyAvailable before scanning.
   */
  resolveContentKey(keyId: string, keyserverUrl: string): Buffer;
  ensureKeyAvailable(keyId: string, keyserverUrl: string): Promise<void>;
}

export type SealedKeyErrorCode =
  | 'KEY_UNAVAILABLE'
  | 'KEY_INVALID'
  | 'MALFORMED_KEY_ID';

export class SealedKeyError extends Error {
  readonly code: SealedKeyErrorCode;

  constructor(code: SealedKeyErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SealedKeyError';
  }
}

export function parseKeyserverKeyId(keyId: string): { bareId: string } {
  if (!keyId.startsWith(KEY_ID_PREFIX) || keyId.length === KEY_ID_PREFIX.length) {
    throw new SealedKeyError('MALFORMED_KEY_ID', `malformed keyId: ${keyId}`);
  }
  const bareId = keyId.slice(KEY_ID_PREFIX.length);
  if (bareId.includes('/') || bareId.includes('\\') || bareId.includes('..')) {
    throw new SealedKeyError('MALFORMED_KEY_ID', `malformed keyId: ${keyId}`);
  }
  return { bareId };
}

export function normalizeKeyserverUrl(keyserverUrl: string): string {
  let url: URL;
  try {
    url = new URL(keyserverUrl);
  } catch {
    throw new SealedKeyError('KEY_INVALID', `invalid keyserverUrl: ${keyserverUrl}`);
  }
  // 刻み(4) で community バンドル header 由来の keyserverUrl（敵対的入力になり得る自己記述設計）が
  // ここへ入ってくる。実際にやっているのはこれだけ: https は無条件許可、http はループバック
  // （127.0.0.1 / ::1 / localhost、開発 Worker・テスト用）のみ許可。塞いでいるのは「平文 http で
  // 内部を叩く」経路だけで、SSRF 面を封鎖してはいない。
  //
  // 塞げていない残余: header の keyserverUrl が https://<内部ホスト> であれば無条件で通る。
  // fetchKey は認証なし・10s timeout・応答は keyId 一致 JSON 以外破棄なので、購読者端末に対する
  // 完全な blind SSRF（内部ネットワークへの GET ping を撃たせられる）が成立し得る。完全な防御には
  // 接続時の IP 解決 + private/link-local レンジ遮断が要る（DNS rebinding があるためホスト名文字列
  // の一致判定だけでは不十分）。それは別トラックの課題であり、本関数はまだ実装していない。
  const isLoopbackHttp =
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !isLoopbackHttp) {
    throw new SealedKeyError('KEY_INVALID', `invalid keyserverUrl scheme: ${keyserverUrl}`);
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function memoryKey(keyserverUrl: string, keyId: string): string {
  return `${keyserverUrl}\n${keyId}`;
}

function cacheFilePath(caveatHome: string, keyserverUrl: string, keyId: string): string {
  const digest = createHash('sha256').update(`${keyserverUrl}\n${keyId}`).digest('hex').slice(0, 32);
  return join(caveatHome, 'keys', `${digest}.json`);
}

function decodeBase64Key(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SealedKeyError('KEY_INVALID', 'content key must be base64');
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== CONTENT_KEY_BYTES) {
    throw new SealedKeyError('KEY_INVALID', 'content key must decode to exactly 32 bytes');
  }
  return key;
}

function readCache(path: string, expected: { keyserverUrl: string; keyId: string }, removeInvalid = true): Buffer | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { keyserverUrl?: unknown }).keyserverUrl !== expected.keyserverUrl ||
      (parsed as { keyId?: unknown }).keyId !== expected.keyId
    ) {
      throw new SealedKeyError('KEY_INVALID', 'cache metadata does not match requested key');
    }
    return decodeBase64Key((parsed as { key?: unknown }).key);
  } catch {
    if (removeInvalid) rmSync(path, { force: true });
    return null;
  }
}

function writeCache(path: string, value: { keyserverUrl: string; keyId: string; key: string }): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(temporary, path);
}

export function createKeyserverKeyProvider(opts: {
  caveatHome: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ContentKeyProvider {
  const memory = new Map<string, Buffer>();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SEALED_KEY_FETCH_TIMEOUT_MS;

  async function fetchKey(keyId: string, keyserverUrl: string): Promise<Buffer> {
    const { bareId } = parseKeyserverKeyId(keyId);
    let response: Response;
    try {
      response = await fetchImpl(`${keyserverUrl}/v1/keys/${encodeURIComponent(bareId)}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SealedKeyError('KEY_UNAVAILABLE', `content key unavailable: ${keyId}`);
    }
    if (!response.ok) {
      throw new SealedKeyError('KEY_UNAVAILABLE', `content key unavailable: HTTP ${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new SealedKeyError('KEY_INVALID', 'keyserver response is not valid JSON');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { keyId?: unknown }).keyId !== bareId
    ) {
      throw new SealedKeyError('KEY_INVALID', 'keyserver response keyId does not match requested key');
    }
    return decodeBase64Key((parsed as { key?: unknown }).key);
  }

  return {
    resolveContentKey(keyId: string, keyserverUrl: string): Buffer {
      const normalizedUrl = normalizeKeyserverUrl(keyserverUrl);
      parseKeyserverKeyId(keyId);
      const cached = memory.get(memoryKey(normalizedUrl, keyId));
      if (!cached) {
        throw new SealedKeyError('KEY_UNAVAILABLE', `content key is not prewarmed: ${keyId}`);
      }
      // 呼び手が返り値を mutate してもキャッシュ本体を破壊しないよう防御コピーを返す。
      return Buffer.from(cached);
    },
    async ensureKeyAvailable(keyId: string, keyserverUrl: string): Promise<void> {
      const normalizedUrl = normalizeKeyserverUrl(keyserverUrl);
      parseKeyserverKeyId(keyId);
      const memKey = memoryKey(normalizedUrl, keyId);
      if (memory.has(memKey)) return;

      const path = cacheFilePath(opts.caveatHome, normalizedUrl, keyId);
      const cached = readCache(path, { keyserverUrl: normalizedUrl, keyId });
      if (cached) {
        memory.set(memKey, cached);
        return;
      }

      const key = await fetchKey(keyId, normalizedUrl);
      memory.set(memKey, key);
      writeCache(path, { keyserverUrl: normalizedUrl, keyId, key: key.toString('base64') });
    },
  };
}

/** Reads an existing content-key cache only. No fetch, cache repair or write. */
export function createCachedContentKeyProvider(opts: { caveatHome: string }): ContentKeyProvider {
  const resolve = (keyId: string, keyserverUrl: string): Buffer => {
    const normalizedUrl = normalizeKeyserverUrl(keyserverUrl); parseKeyserverKeyId(keyId);
    const key = readCache(cacheFilePath(opts.caveatHome, normalizedUrl, keyId), { keyserverUrl: normalizedUrl, keyId }, false);
    if (!key) throw new SealedKeyError('KEY_UNAVAILABLE', 'existing cached content key is unavailable');
    return key;
  };
  return { resolveContentKey: resolve, async ensureKeyAvailable(keyId, keyserverUrl) { resolve(keyId, keyserverUrl); } };
}
