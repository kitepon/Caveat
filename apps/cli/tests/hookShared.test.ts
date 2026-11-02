import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookSearchInput, SearchResult } from '@caveat/core';
import { searchCaveatsSafely, type HookHost } from '../src/hookShared.js';

const m = vi.hoisted(() => ({ exists: vi.fn(), context: vi.fn(), open: vi.fn(), close: vi.fn(), search: vi.fn(), segments: vi.fn(), applies: vi.fn(), mark: vi.fn(), miss: vi.fn(), diagnostic: vi.fn(), aclClose: vi.fn() }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: m.exists }));
vi.mock('../src/context.js', () => ({ buildContext: m.context }));
vi.mock('../src/runtimeErrorReportTrigger.js', () => ({ maybeTriggerRuntimeErrorReport: vi.fn() }));
vi.mock('@caveat/core', async original => ({
  ...await original<typeof import('@caveat/core')>(), openDb: m.open,
  findCaveatsForHook: m.search, findCaveatsForHookSegments: m.segments,
  environmentAppliesToTask: m.applies, defaultSelfIdentityTokens: () => new Set(), fingerprint: () => ({ os: 'linux' }),
  markHit: m.mark, logHookQueryMiss: m.miss, observeRuntimeError: vi.fn(), observeHookDiagnostic: m.diagnostic,
  createWindowsAclSession: () => ({ run: vi.fn(), close: m.aclClose }),
}));
const input: HookSearchInput = { topicText: 'known topic', failureText: 'search failure', surface: 'tool_error' };
const hit: SearchResult = { id: 'known', source: 'own', title: 'Known', symptomExcerpt: 'Failure', confidence: 'confirmed', visibility: 'private', environment: {} };
const fail = () => { throw new Error('injected failure'); };
beforeEach(() => {
  vi.resetAllMocks(); m.exists.mockReturnValue(true);
  m.context.mockReturnValue({ caveatHome: '/unused', paths: { dbPath: '/unused/db' } });
  m.open.mockReturnValue({ close: m.close });
  m.search.mockReturnValue([hit]); m.segments.mockReturnValue([hit]); m.applies.mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
const hosts: HookHost[] = [
  { agent: 'claude', stderrTag: 'caveat:hook', errorCode: 'CAVEAT.CLAUDE_HOOK_FAILED', stopStateDir: 'hook', stopDedupeKey: 'stop' },
  { agent: 'codex', stderrTag: 'caveat:codex-hook', errorCode: 'CAVEAT.CODEX_HOOK_FAILED', stopStateDir: 'codex', stopDedupeKey: 'stop' },
  { agent: 'cursor', stderrTag: 'caveat:cursor-hook', errorCode: 'CAVEAT.CURSOR_HOOK_FAILED', stopStateDir: 'cursor', stopDedupeKey: 'stop' },
];
describe.each(hosts)('$agent search DB lifetime', host => {
  it('returns hits and marks them before closing once', () => {
    expect(searchCaveatsSafely(host, input)).toEqual([hit]);
    expect(m.mark).toHaveBeenCalledWith(m.open.mock.results[0]!.value, [hit]);
    expect(m.close).toHaveBeenCalledTimes(1);
    expect(m.mark.mock.invocationCallOrder[0]).toBeLessThan(m.close.mock.invocationCallOrder[0]!);
  });
  it.each(['search', 'segments', 'applies'] as const)('closes after %s fails', phase => {
    m[phase].mockImplementation(fail);
    expect(searchCaveatsSafely(host, phase === 'segments' ? [input, input] : input)).toEqual([]);
    expect(m.close).toHaveBeenCalledTimes(1);
    expect(m.diagnostic).toHaveBeenCalledWith(host.errorCode, 'search error', expect.any(Error), expect.any(Object));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining(`[${host.stderrTag}] search error:`));
  });
  it.each(['mark', 'miss'] as const)('preserves the search result after %s fails', phase => {
    const hits = phase === 'miss' ? [] : [hit]; m.search.mockReturnValue(hits); m[phase].mockImplementation(fail);
    expect(searchCaveatsSafely(host, input)).toEqual(hits); expect(m.close).toHaveBeenCalledTimes(1);
  });
  it.each(['search', 'mark', 'miss'] as const)('closes even when %s diagnostics throw', phase => {
    if (phase === 'miss') m.search.mockReturnValue([]);
    m[phase].mockImplementation(fail); m.diagnostic.mockImplementation(fail);
    expect(() => searchCaveatsSafely(host, input)).toThrow('injected failure');
    expect(m.close).toHaveBeenCalledTimes(1); expect(m.aclClose).toHaveBeenCalledTimes(1);
  });
  it.each(['empty', 'context', 'missing', 'open'] as const)('does not close an unowned DB: %s', phase => {
    if (phase === 'context') m.context.mockImplementation(fail);
    if (phase === 'missing') m.exists.mockReturnValue(false);
    if (phase === 'open') m.open.mockImplementation(fail);
    expect(searchCaveatsSafely(host, phase === 'empty' ? [] : input)).toEqual([]);
    expect(m.close).not.toHaveBeenCalled(); expect(m.open).toHaveBeenCalledTimes(phase === 'open' ? 1 : 0);
  });
  it('propagates close failure', () => {
    m.close.mockImplementation(fail);
    expect(() => searchCaveatsSafely(host, input)).toThrow('injected failure'); expect(m.close).toHaveBeenCalledTimes(1);
  });
});
