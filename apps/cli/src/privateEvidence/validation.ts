import { createHash } from 'node:crypto';
import { TextDecoder, isDeepStrictEqual } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { visit } from 'jsonc-parser';
import capabilitySchema from '../contracts/factory-private-evidence/capability.v1.schema.json' with { type: 'json' };
import frameSchema from '../contracts/factory-private-evidence/private-frame.v1.schema.json' with { type: 'json' };
import windowsSchema from '../contracts/factory-private-evidence/windows-channel.v1.schema.json' with { type: 'json' };

const ajv = new Ajv2020({ strict: true, strictRequired: false });
export const validateCapability = ajv.compile(capabilitySchema);
export const validateFrame = ajv.compile(frameSchema);
export const validateWindowsDescriptor = ajv.compile(windowsSchema);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{64}$/;
export const MAX_CHANNEL_BYTES = 16384;

/** Strict, bounded JSON. The parser library supplies tokenization and nesting events. */
export function strictJson(bytes: Uint8Array, limit = MAX_CHANNEL_BYTES): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) throw new Error('json_budget');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const objects: Set<string>[] = [];
  let depth = 0, invalid = false;
  visit(text, {
    onObjectBegin() { if (++depth > 32) throw new Error('json_depth'); objects.push(new Set()); },
    onObjectProperty(key) { const keys = objects.at(-1)!; if (keys.has(key)) invalid = true; keys.add(key); },
    onObjectEnd() { objects.pop(); depth--; },
    onArrayBegin() { if (++depth > 32) throw new Error('json_depth'); },
    onArrayEnd() { depth--; },
    onError() { invalid = true; },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (invalid || depth !== 0 || objects.length !== 0) throw new Error('json_invalid');
  return JSON.parse(text);
}

type Dict = Record<string, any>; // Schema checks narrow every use below; values never enter logs.
export function validateRequest(env: Readonly<Record<string, string | undefined>>) {
  if (env.CAVEAT_FACTORY_PRIVATE_EVIDENCE !== 'v1') return { status: 'off' } as const;
  const collection = env.CAVEAT_FACTORY_PRIVATE_COLLECTION_ID;
  const nonce = env.CAVEAT_FACTORY_PRIVATE_NONCE;
  const channel = env.CAVEAT_FACTORY_PRIVATE_CHANNEL;
  if (!collection || !UUID.test(collection) || !nonce || !NONCE.test(nonce) || !channel || channel.length > MAX_CHANNEL_BYTES)
    return { status: 'unverified', reason: 'request_invalid' } as const;
  if (channel === 'fd:3') return { status: 'valid', collection_id: collection, nonce, transport: 'posix-fd-v1' } as const;
  try {
    const descriptor = strictJson(Buffer.from(channel));
    if (validateWindowsDescriptor(descriptor))
      return { status: 'valid', collection_id: collection, nonce, transport: 'windows-named-pipe-v1' } as const;
  } catch { /* A fixed reason only; never propagate an input or parser error. */ }
  return { status: 'unverified', reason: 'request_invalid' } as const;
}

export function selectCapability(request: ReturnType<typeof validateRequest>, capability: unknown,
  expectedVersion: string, platform: string, launchPath: string) {
  if (request.status === 'off') return { status: 'off' } as const;
  if (request.status !== 'valid') return { status: 'unverified', reason: 'request_invalid' } as const;
  if (capability == null) return { status: 'not_supported', reason: 'capability_absent' } as const;
  if (!validateCapability(capability) || (capability as Dict).package_version !== expectedVersion)
    return { status: 'unverified', reason: 'capability_invalid' } as const;
  const common = (capability as Dict).transports.some((t: Dict) =>
    t.id === request.transport && t.platforms.includes(platform) && t.launch_paths.includes(launchPath));
  // This pure selection is NOT permission to open a channel. OS safety must be separately established.
  return common ? { status: 'candidate_requires_os_verification' } as const
    : { status: 'not_supported', reason: 'transport_unsupported' } as const;
}

/** Validates a synthetic or already received complete channel. Does not read/send a real channel. */
export function validateExchange(input: {
  channelBytes: Uint8Array; eof: boolean; publicBytes: Uint8Array;
  request: ReturnType<typeof validateRequest>; capability: unknown; expectedVersion: string;
  peerVerified: boolean; expectedProcess: unknown; platform: string; launchPath: string;
}): { status: 'valid' | 'unverified'; reason: string } {
  const bad = (reason: string) => ({ status: 'unverified', reason } as const);
  try {
    if (input.request.status !== 'valid' || !input.eof || !input.peerVerified) return bad('channel_incomplete');
    if (!validateCapability(input.capability) || (input.capability as Dict).package_version !== input.expectedVersion)
      return bad('capability_invalid');
    if (input.channelBytes.byteLength > MAX_CHANNEL_BYTES) return bad('channel_budget');
    const bytes = Buffer.from(input.channelBytes);
    if (bytes.at(-1) !== 10) return bad('frame_framing');
    const lines = bytes.toString('latin1').split('\n');
    if (lines.length !== 3 || lines[2] !== '') return bad('frame_framing');
    const frames = lines.slice(0, 2).map(line => strictJson(Buffer.from(line, 'latin1')) as Dict);
    if (frames.some(frame => !validateFrame(frame))) return bad('frame_schema');
    const [hello, result] = frames as [Dict, Dict];
    if (hello.type !== 'hello' || result.type !== 'diagnostic_result') return bad('frame_order');
    if (!UUID.test(hello.execution_id)) return bad('frame_identity');
    for (const key of ['schema', 'collection_id', 'nonce', 'execution_id'])
      if (hello[key] !== result[key]) return bad('frame_identity');
    if (hello.collection_id !== input.request.collection_id || hello.nonce !== input.request.nonce ||
        hello.product_version !== input.expectedVersion || hello.process.package_version !== input.expectedVersion ||
        hello.transport !== input.request.transport) return bad('frame_identity');
    if (selectCapability(input.request, input.capability, input.expectedVersion, input.platform, input.launchPath).status !==
        'candidate_requires_os_verification') return bad('transport_unsupported');
    const p = hello.process;
    if (!input.expectedProcess || !isDeepStrictEqual(p, input.expectedProcess)) return bad('peer_identity');
    const needed: string[] = [];
    for (const [key, reason] of [['parent_pid', 'parent_identity_unavailable'], ['exec_path', 'exec_path_unavailable'],
      ['entry_realpath', 'entry_path_unavailable'], ['build_id', 'build_id_unavailable']])
      if (p[key!] === null) needed.push(reason!);
    if (p.start_identity.source === 'unavailable') needed.push('start_identity_unavailable');
    if (p.identity.kind === 'unknown') needed.push('actor_identity_unavailable');
    if (!isDeepStrictEqual([...needed].sort(), [...p.missing_reasons].sort())) return bad('process_missing_reason');
    if (input.publicBytes.at(-1) !== 10 || input.publicBytes.subarray(0, -1).includes(10)) return bad('public_framing');
    const pub = strictJson(input.publicBytes, 65536) as Dict;
    if (pub.schema !== hello.public_diagnostic_schema || pub.product !== 'caveat' || pub.version !== input.expectedVersion ||
        pub.overall?.status !== result.public_result.overall_status || pub.sync?.status !== result.sync_observation.status ||
        pub.sync?.reason_code !== result.sync_observation.reason_code) return bad('public_mismatch');
    if (result.public_output.bytes !== input.publicBytes.byteLength || result.public_output.sha256 !==
        createHash('sha256').update(input.publicBytes).digest('hex')) return bad('public_bytes_mismatch');
    const sync = result.sync_observation;
    const both = sync.local_head.status === 'observed' && sync.remote_head.status === 'observed';
    const comparison = both ? sync.local_head.value === sync.remote_head.value ? 'equal' : 'different' : 'not_evaluated';
    if (sync.comparison !== comparison) return bad('head_comparison');
    const repo = sync.repo_identity;
    const allowed = repo.status === 'available' ? ['origin_descriptor_observed'] : repo.status === 'not_observed'
      ? ['origin_not_reached'] : ['origin_capture_unverified', 'origin_syntax_unsupported', 'origin_semantics_ambiguous'];
    if (!allowed.includes(repo.reason)) return bad('origin_reason');
    return { status: 'valid', reason: 'complete_synthetic_exchange' };
  } catch { return bad('exchange_invalid'); }
}
