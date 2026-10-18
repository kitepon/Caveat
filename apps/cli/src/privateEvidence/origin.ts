import { createHash } from 'node:crypto';

export const ORIGIN_ALGORITHM = 'origin-descriptor-sha256-v1';
export type OriginIdentity = {
  status: 'available' | 'not_observed' | 'unverified';
  algorithm: typeof ORIGIN_ALGORITHM | null;
  digest: string | null;
  reason: string;
};
export type AcquiredValue = {
  run_id: string;
  status: 'observed' | 'not_observed' | 'unverified';
  value: string | null;
  complete: boolean;
};
const missing = (status: 'not_observed' | 'unverified', reason: string): OriginIdentity =>
  ({ status, algorithm: null, digest: null, reason });

/** Input is an already acquired value; never queries Git, config, DNS, files or state. */
export function projectOrigin(runId: string, input: AcquiredValue): OriginIdentity {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId) || input.run_id !== runId || !input.complete || input.status === 'unverified')
    return missing('unverified', 'origin_capture_unverified');
  if (input.status === 'not_observed') return missing('not_observed', 'origin_not_reached');
  if (typeof input.value !== 'string') return missing('unverified', 'origin_capture_unverified');
  const text = input.value.replace(/\r?\n$/, '');
  const unsupported = () => missing('unverified', 'origin_syntax_unsupported');
  if (!text || text.length > 4096 || /[^\x21-\x7e]|[%\\?#]/.test(text)) return unsupported();
  let form: 'url' | 'scp';
  let scheme: string | null = null;
  let host: string;
  let port: string | null = null;
  let path: string;
  if (text.includes('://')) {
    const parsed = /^(https?|ssh|git):\/\/(?:[A-Za-z0-9._-]+@)?([^/:@]+)(?::([1-9][0-9]{0,4}))?(\/.*)$/i.exec(text);
    if (!parsed) return unsupported();
    form = 'url'; scheme = parsed[1]!.toLowerCase(); host = parsed[2]!; port = parsed[3] ?? null; path = parsed[4]!;
    if (port !== null && Number(port) > 65535) return unsupported();
  } else {
    const parsed = /^(?:[A-Za-z0-9._-]+@)?([^/:@]+):(.*)$/.exec(text);
    if (!parsed) return unsupported();
    if (!parsed[2]!.startsWith('/')) return missing('unverified', 'origin_semantics_ambiguous');
    form = 'scp'; host = parsed[1]!; path = parsed[2]!;
  }
  const labels = host.split('.');
  if (host.length > 253 || labels.every(label => /^[0-9]+$/.test(label)) ||
      labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return unsupported();
  if (!/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/.test(path) ||
      path.split('/').some(segment => segment === '.' || segment === '..')) return unsupported();
  const tuple = ['caveat.origin-descriptor.v1', form, scheme, host.toLowerCase(), port, 'absolute', path];
  return { status: 'available', algorithm: ORIGIN_ALGORITHM,
    digest: createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex'), reason: 'origin_descriptor_observed' };
}

export function projectHead(runId: string, input: AcquiredValue) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId) || input.run_id !== runId || !input.complete || input.status === 'unverified')
    return { status: 'unverified', value: null, reason: 'head_capture_unverified' } as const;
  if (input.status === 'not_observed') return { status: 'not_observed', value: null, reason: 'head_not_reached' } as const;
  if (typeof input.value !== 'string' || !/^[0-9a-f]{40}$/.test(input.value))
    return { status: 'unverified', value: null, reason: 'head_format_unsupported' } as const;
  return { status: 'observed', value: input.value, reason: 'head_observed' } as const;
}

export function projectSync(runId: string, acquired: {
  origin: AcquiredValue; local: AcquiredValue; remote: AcquiredValue;
}, publicSync: { status: 'ready' | 'not_ready' | 'unverified'; reason_code: string }) {
  const local = projectHead(runId, acquired.local), remote = projectHead(runId, acquired.remote);
  return { ...publicSync, repo_identity: projectOrigin(runId, acquired.origin), local_head: local, remote_head: remote,
    comparison: local.status === 'observed' && remote.status === 'observed'
      ? local.value === remote.value ? 'equal' : 'different' : 'not_evaluated',
    relation_counts: { status: 'not_supported', behind: null, ahead: null } };
}
