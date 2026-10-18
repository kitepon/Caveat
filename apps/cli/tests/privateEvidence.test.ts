import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fixture from './fixtures/private-evidence/contract.v1.json' with { type: 'json' };
import { projectOrigin, projectHead, projectSync, type AcquiredValue } from '../src/privateEvidence/origin.js';
import { planOptionalEvidence } from '../src/privateEvidence/candidate.js';
import { strictJson, validateCapability, validateFrame, validateWindowsDescriptor,
  validateRequest, selectCapability, validateExchange } from '../src/privateEvidence/validation.js';
const run = fixture.hello.collection_id;
const acquired = (value: string | null, extra: Partial<AcquiredValue> = {}): AcquiredValue =>
  ({ run_id: run, status: 'observed', value, complete: true, ...extra });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function exchange(hello: any = fixture.hello, result: any = fixture.result) {
  return { channelBytes: Buffer.from(JSON.stringify(hello) + '\n' + JSON.stringify(result) + '\n'), eof: true,
    publicBytes: Buffer.from(fixture.public_bytes_utf8), request: validateRequest(fixture.request_env),
    capability: fixture.synthetic_capability, expectedVersion: '0.20.3', peerVerified: true,
    expectedProcess: fixture.hello.process, platform: 'linux', launchPath: 'direct_node_entry' };
}

describe('same-run pure projection', () => {
  it('matches the fixed cross-language origin digest and emits no origin/user/path', () => {
    const result = projectOrigin(run, acquired(fixture.origin_input));
    expect(result).toEqual(fixture.result.sync_observation.repo_identity);
    expect(JSON.stringify(result)).not.toContain('example.invalid');
  });
  it.each(['https://example.invalid/org/repo.git','HTTPS://example.invalid/org/repo.git\r\n',
    'https://user@example.invalid/org/repo.git'])('canonical descriptor %s', value => {
    expect(projectOrigin(run, acquired(value)).digest).toBe(fixture.expected_origin_digest);
  });
  it.each(['http://example.invalid/org/repo.git','https://example.invalid:443/org/repo.git',
    'https://example.invalid/org/repo','https://example.invalid/org/repo.git/',
    'https://example.invalid/Org/repo.git','ssh://git@example.invalid/org/repo.git',
    'git@example.invalid:/org/repo.git'])('keeps distinct syntax/transport/path %s', value => {
    const output = projectOrigin(run, acquired(value)); expect(output.status).toBe('available');
    expect(output.digest).not.toBe(fixture.expected_origin_digest);
  });
  it('does not equate URL and scp SSH', () => {
    expect(projectOrigin(run, acquired('ssh://git@example.invalid/org/repo')).digest)
      .not.toBe(projectOrigin(run, acquired('git@example.invalid:/org/repo')).digest);
  });
  it.each(['git@example.invalid:org/repo','https://example.invalid/a?token=secret',
    'https://example.invalid/a#ref','https://user:password@example.invalid/a','file:///a',
    'https://127.0.0.1/a','ssh://[::1]/a','https://example.invalid./a',
    'https://example.invalid:0/a','https://example.invalid:0443/a','https://example.invalid:65536/a',
    'https://example.invalid/a/../b','https://example.invalid/a//b','https://example.invalid/%61',
    'https://example.invalid/あ','https://example.invalid/~user/a',' https://example.invalid/a',
    'https://example.invalid/a\n\n','https://example.invalid/a\u0000','https://example.invalid/' + 'a'.repeat(4096)])(
    'ambiguous or unsupported input remains missing %s', value => {
      const result = projectOrigin(run, acquired(value)); expect(result.status).toBe('unverified');
      expect(result.algorithm).toBeNull(); expect(result.digest).toBeNull();
      expect(JSON.stringify(result)).not.toContain('secret');
    });
  it('does not substitute other-run or incomplete values', () => {
    for (const extra of [{ run_id: 'other-run' }, { complete: false }, { status: 'unverified' as const }]) {
      expect(projectOrigin(run, acquired(fixture.origin_input, extra)).status).toBe('unverified');
      expect(projectHead(run, acquired('a'.repeat(40), extra)).value).toBeNull();
    }
    expect(projectOrigin(run, acquired(null, {status:'not_observed'})).reason).toBe('origin_not_reached');
  });
  it('rejects invalid matching run IDs without substituting measurements', () => {
    expect(projectHead('bad',acquired('a'.repeat(40),{run_id:'bad'})).status).toBe('unverified');
    expect(projectOrigin('bad',acquired(fixture.origin_input,{run_id:'bad'})).status).toBe('unverified');
  });
  it.each(['a'.repeat(64),'A'.repeat(40),'a'.repeat(39),'a'.repeat(40)+'\n'])('unsupported HEAD %s', value => {
    expect(projectHead(run, acquired(value)).status).toBe('unverified');
  });
  it('separates public reason_code and private reason, never invents relation counts/receipt', () => {
    const projection = projectSync(run, {origin:acquired(fixture.origin_input),local:acquired('a'.repeat(40)),remote:acquired('b'.repeat(40))},
      {status:'not_ready',reason_code:'remote_mismatch'});
    expect(projection).toEqual(fixture.result.sync_observation);
    expect(projection.repo_identity).not.toHaveProperty('reason_code');
    expect(projection.relation_counts).toEqual({status:'not_supported',behind:null,ahead:null});
  });
  it('comparison needs both current-run HEADs', () => {
    const common={origin:acquired(null,{status:'not_observed'}),local:acquired('a'.repeat(40)),remote:acquired(null,{status:'not_observed'})};
    expect(projectSync(run,common,{status:'unverified',reason_code:'upstream_unavailable'}).comparison).toBe('not_evaluated');
    common.remote=acquired('a'.repeat(40));
    expect(projectSync(run,common,{status:'ready',reason_code:'ready'}).comparison).toBe('equal');
  });
});

describe('official schemas and strict inputs', () => {
  it('accepts fixed fixture frames/capability/Windows descriptor', () => {
    expect(validateCapability(fixture.synthetic_capability)).toBe(true);
    expect(validateFrame(fixture.hello)).toBe(true);expect(validateFrame(fixture.result)).toBe(true);
    expect(validateWindowsDescriptor(fixture.windows_descriptor)).toBe(true);
  });
  it('requires private reason, refuses reason_code and old algorithm', () => {
    const frame=structuredClone(fixture.result) as any;
    frame.sync_observation.repo_identity.reason_code=frame.sync_observation.repo_identity.reason;
    delete frame.sync_observation.repo_identity.reason;expect(validateFrame(frame)).toBe(false);
    const old=structuredClone(fixture.result);old.sync_observation.repo_identity.algorithm='origin-host-path-sha256-v1';
    expect(validateFrame(old)).toBe(false);
  });
  it.each(['0x20x3','01.20.3','0.20','0.20.3-01'])('rejects invalid semver %s', version => {
    expect(validateCapability({...fixture.synthetic_capability,package_version:version})).toBe(false);
  });
  it.each(['{"a":1,"a":2}','{"a":{"b":1,"b":2}}','{"a":1,"\\u0061":2}',
    '{/*comment*/"a":1}','{"a":1,}','{} {}','', '{"a":NaN}', '\ufeff{}'])('rejects malformed/duplicate JSON %s', text => {
    expect(()=>strictJson(Buffer.from(text))).toThrow();
  });
  it('rejects invalid UTF8, depth and budget; accepts separate equal keys in array objects', () => {
    expect(()=>strictJson(Uint8Array.from([0xc3,0x28]))).toThrow();
    expect(()=>strictJson(Buffer.from('['.repeat(33)+'0'+']'.repeat(33)))).toThrow();
    expect(()=>strictJson(Buffer.alloc(16385,32))).toThrow();
    expect(strictJson(Buffer.from('[{"a":1},{"a":2}]'))).toEqual([{a:1},{a:2}]);
  });
  it('validates request shape without opening either channel', () => {
    expect(validateRequest(fixture.request_env).status).toBe('valid');
    expect(validateRequest({...fixture.request_env,CAVEAT_FACTORY_PRIVATE_CHANNEL:JSON.stringify(fixture.windows_descriptor)}).status).toBe('valid');
    for(const key of ['CAVEAT_FACTORY_PRIVATE_COLLECTION_ID','CAVEAT_FACTORY_PRIVATE_NONCE','CAVEAT_FACTORY_PRIVATE_CHANNEL']) {
      expect(validateRequest({...fixture.request_env,[key]:''}).status).toBe('unverified');
    }
    for(const channel of ['fd:1','fd:2','fd:4',JSON.stringify({...fixture.windows_descriptor,path:'\\\\remote\\pipe\\evil'})])
      expect(validateRequest({...fixture.request_env,CAVEAT_FACTORY_PRIVATE_CHANNEL:channel}).status).toBe('unverified');
  });
  it('OFF does not read other env values; unsupported capability does not invent transport', () => {
    const env={CAVEAT_FACTORY_PRIVATE_EVIDENCE:undefined,get CAVEAT_FACTORY_PRIVATE_CHANNEL(){throw Error('must not read')}};
    expect(validateRequest(env).status).toBe('off');
    const cap={...fixture.synthetic_capability,transports:[]};
    for(const platform of ['linux','darwin','win32'])
      expect(selectCapability(validateRequest(fixture.request_env),cap,'0.20.3',platform,'direct_node_entry').status).toBe('not_supported');
    expect(selectCapability(validateRequest(fixture.request_env),null,'0.20.3','linux','direct_node_entry').status).toBe('not_supported');
    expect(selectCapability(validateRequest(fixture.request_env),cap,'0.20.4','linux','direct_node_entry').status).toBe('unverified');
  });
});

describe('complete synthetic frame exchange', () => {
  it('matches fixed public bytes, binding, peer/nonce/EOF and comparison', () => {
    expect(validateExchange(exchange()).status).toBe('valid');
    // Structural identity equality must not depend on key serialization order.
    expect(validateExchange({...exchange(),expectedProcess:Object.fromEntries(Object.entries(fixture.hello.process).reverse())}).status).toBe('valid');
  });
  it('accepts null fields only with the exact schema-owned missing reason', () => {
    const hello=structuredClone(fixture.hello) as any;hello.process.entry_realpath=null;
    hello.process.missing_reasons=['entry_path_unavailable'];
    expect(validateExchange({...exchange(hello),expectedProcess:hello.process}).status).toBe('valid');
    hello.process.missing_reasons=['entry_path_unavailable','build_id_unavailable'];
    expect(validateExchange({...exchange(hello),expectedProcess:hello.process}).status).toBe('unverified');
  });
  it.each(['nonce','collection_id','execution_id','product_version','transport'])('rejects changed hello %s', key => {
    const hello=structuredClone(fixture.hello) as any;hello[key]=key==='transport'?'windows-named-pipe-v1':'wrong';
    expect(validateExchange(exchange(hello)).status).toBe('unverified');
  });
  it.each([['win32','direct_node_entry'],['linux','unknown_wrapper']])('rejects unsupported platform/launch %s/%s', (platform,launchPath) => {
    expect(validateExchange({...exchange(),platform,launchPath}).status).toBe('unverified');
  });
  it.each(['eof','peerVerified'])('requires %s', key => {
    expect(validateExchange({...exchange(),[key]:false}).status).toBe('unverified');
  });
  it.each(['comparison','reason','receipt','public_hash','public_status','exit','process_missing_reason','unexpected_key','peer'])('rejects inconsistency %s', kind => {
    const hello=structuredClone(fixture.hello) as any,result=structuredClone(fixture.result) as any;
    if(kind==='comparison')result.sync_observation.comparison='equal';
    if(kind==='reason')result.sync_observation.repo_identity.reason='ready';
    if(kind==='receipt')result.operation_receipt.receipt={ok:true};
    if(kind==='public_hash')result.public_output.sha256='0'.repeat(64);
    if(kind==='public_status')result.sync_observation.reason_code='ready';
    if(kind==='exit')result.public_result.planned_exit_code=0;
    if(kind==='process_missing_reason')hello.process.entry_realpath=null;
    if(kind==='unexpected_key')result.raw='secret';
    if(kind==='peer')hello.process.pid++;
    expect(validateExchange(exchange(hello,result)).status).toBe('unverified');
  });
  it('rejects reversed/extra/partial frames and byte overflow', () => {
    const input=exchange();const frames=input.channelBytes.toString().trimEnd().split('\n');
    for(const text of [frames.reverse().join('\n')+'\n',input.channelBytes.toString()+'{}\n',frames[0]+'\n',input.channelBytes.toString().slice(0,-1),' '.repeat(16385)])
      expect(validateExchange({...input,channelBytes:Buffer.from(text)}).status).toBe('unverified');
  });
  it('hashes actual public bytes, not reserialized JSON', () => {
    const input=exchange();const differentlySpaced=Buffer.from(fixture.public_bytes_utf8.replace(':', ': '));
    expect(validateExchange({...input,publicBytes:differentlySpaced}).status).toBe('unverified');
    const result=structuredClone(fixture.result);result.public_output.bytes=differentlySpaced.length;
    result.public_output.sha256=createHash('sha256').update(differentlySpaced).digest('hex');
    expect(validateExchange({...exchange(fixture.hello,result),publicBytes:differentlySpaced}).status).toBe('valid');
  });
});

describe('isolated OFF/public outcome and fake sink boundary', () => {
  it.each([0,1,17])('OFF never prepares/sends and preserves exact bytes/exit %s', exit => {
    const pub=Buffer.from(fixture.public_bytes_utf8),prepare=vi.fn(()=>{throw Error('not called')}),sink=vi.fn();
    const result=planOptionalEvidence(false,pub,exit,prepare);
    if(result.privateCandidate!==null)sink(result.privateCandidate);
    expect(prepare).not.toHaveBeenCalled();expect(sink).not.toHaveBeenCalled();
    expect(result.publicBytes).toBe(pub);expect(result.exitCode).toBe(exit);
  });
  it('prepare and fake sink failure cannot rewrite public bytes/exit', () => {
    const pub=Buffer.from(fixture.public_bytes_utf8);
    const failure=planOptionalEvidence(true,pub,1,()=>{throw Error('private rejected')});
    expect(failure.privateStatus).toBe('unverified');expect(failure.publicBytes).toBe(pub);expect(failure.exitCode).toBe(1);
    // Fake sink is exercised inside the same optional boundary; its throw must be contained.
    const sink=vi.fn(()=>{throw Error('private denied')});
    const result=planOptionalEvidence(true,pub,1,()=>{sink();return fixture.result;});
    expect(sink).toHaveBeenCalledOnce();expect(result.privateStatus).toBe('unverified');
    expect(result.publicBytes).toBe(pub);expect(result.exitCode).toBe(1);
  });
});
