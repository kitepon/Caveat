import { isolatedGitEnv } from '../../../scripts/test-git-env.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../src/gitRuntime.js';

const GIT_RUNTIME_TEST_TIMEOUT_MS = 15_000;

let tmpDir: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    tmpDir = undefined;
  }
});

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'caveat-git-runtime-'));
  for (const [key, value] of Object.entries(isolatedGitEnv(join(tmpDir, 'git-home')))) vi.stubEnv(key, /^GIT_CONFIG/i.test(key) ? undefined : value);
  return tmpDir;
}

async function startLocalServer(
  handler: (res: ServerResponse) => void,
): Promise<{ url: string; activeSocketCount: () => number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => handler(res));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', onListening);
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/x.git`,
    activeSocketCount: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('createGit runtime policy', { timeout: GIT_RUNTIME_TEST_TIMEOUT_MS }, () => {
  it('lets the HTTP helper timeout preempt the direct-child timeout despite conflicting inherited env', async () => {
    const root = makeTmpDir();
    vi.stubEnv('GIT_HTTP_LOW_SPEED_LIMIT', '0');
    vi.stubEnv('GIT_HTTP_LOW_SPEED_TIME', '999');
    const server = await startLocalServer(() => {
      // Accept the connection but never write response data. simple-git's
      // timeout rejects the task, while Caveat's Git env must override the
      // inherited disabling values and terminate git-remote-http as well.
    });

    try {
      const git = createGit(root, { timeoutMs: 6_000 });
      await git.init();
      const error = await git.clone(server.url, join(root, 'clone'))
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toMatchObject({ plugin: 'timeout' });
      expect(String(error)).toMatch(/operation too slow|less than .* bytes\/sec/i);
      await waitForNoSockets(server.activeSocketCount, 3_000);
      expect(server.activeSocketCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('disables interactive terminal prompts for git http authentication', async () => {
    const root = makeTmpDir();
    const server = await startLocalServer((res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
      res.end();
    });

    try {
      await expect(
        createGit(root).clone(server.url, join(root, 'clone')),
      ).rejects.toThrow(/terminal prompts disabled/i);
    } finally {
      await server.close();
    }
  });

  it('passes the inactivity bound to the git HTTP helper', async () => {
    const git = createGit(makeTmpDir(), { timeoutMs: 6_000 });

    await expect(git.raw(['config', '--get', 'http.lowSpeedLimit'])).resolves.toBe('1\n');
    await expect(git.raw(['config', '--get', 'http.lowSpeedTime'])).resolves.toBe('1\n');
  });

  it('rejects a timeout too short to let the HTTP helper preempt safely', () => {
    expect(() => createGit(makeTmpDir(), { timeoutMs: 5_999 })).toThrow('at least 6000');
  });

  it('removes inherited pager variables without changing the parent', async () => {
    vi.stubEnv('PAGER', '');

    await expect(createGit(makeTmpDir()).init()).resolves.toBeDefined();
  });

  it('refuses inherited ssh command variables without an automatic opt-in', async () => {
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh');

    await expect((async () => createGit(makeTmpDir()).init())()).rejects.toMatchObject({ code: 'CAVEAT_GIT_ENV_UNSAFE' });
  });
});

async function waitForNoSockets(activeSocketCount: () => number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeSocketCount() > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}


it('permits the product-owned named helper through real simple-git without persisting it', async () => {
  const root = makeTmpDir();
  const git = createGit(root, { githubUser: 'fixture-target' });
  await git.init();
  await expect(git.raw(['config', '--get', 'credential.https://github.com.username'])).resolves.toBe('fixture-target\n');
  expect(readFileSync(join(root, '.git', 'config'), 'utf8')).not.toMatch(/fixture-target|credential/);
});
