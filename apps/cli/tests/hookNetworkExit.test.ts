import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeJevKey } from '../src/jevCredential.js';

for (const host of ['claude','codex']) it(`${host} hook drains HTTP cleanup after a Jev decision`,()=> {
  const root=mkdtempSync(join(tmpdir(),'caveat-http-exit-'));
  const userHome=join(root,'home');
  const caveatHome=join(root,'caveat');
  try {
    mkdirSync(userHome,{recursive:true});
    writeFileSync(join(userHome,'.caveatrc.json'),JSON.stringify({jevEnabled:true}));
    writeJevKey(caveatHome,'fixture-key-not-a-real-credential');
    const result=spawnSync(process.execPath,[
      '--import','tsx','--import',new URL('./fixtures/hook-network-exit.mjs',import.meta.url).href,
      fileURLToPath(new URL('../src/index.ts',import.meta.url)),host==='claude'?'hook':'codex-hook','user-prompt-submit',
    ],{encoding:'utf8',timeout:20000,cwd:fileURLToPath(new URL('..',import.meta.url)),
      input:JSON.stringify({session_id:'fixture',cwd:root,transcript_path:join(root,'transcript.jsonl'),prompt:'continue'}),
      env:{...process.env,HOME:userHome,USERPROFILE:userHome,CAVEAT_HOME:caveatHome,CAVEAT_AUTO_SYNC:'off',CAVEAT_INDEX_AUTOSYNC:'off'}});
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('hook-http-cleanup-drained');
    expect(result.stderr).not.toContain('Jev判定に失敗');
    const files=readdirSync(join(caveatHome,'jev-observations'));
    expect(files).toHaveLength(1);
    const recorded=JSON.parse(readFileSync(join(caveatHome,'jev-observations',files[0]!), 'utf8'));
    expect(recorded).toMatchObject({host,decision:'below_struggle_threshold'});
    expect(recorded.turns).toHaveLength(3);
  } finally {rmSync(root,{recursive:true,force:true});}
},30000);
