// One isolated same-host comparison, never an OS-cache-cold benchmark.
// Invokes ordinary successful hooks directly: no native trust or provider calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function measureManagedHookTiming(candidateRoot, oldRoot, fixtureRoot) {
  const candidateVersion=JSON.parse(readFileSync(join(candidateRoot,'package.json'),'utf8')).version;
  const candidateCli=join(candidateRoot,'dist','caveat.js'), oldCli=join(oldRoot,'dist','caveat.js');
  const modes=[['old-direct',oldCli],['candidate-direct',candidateCli],['candidate-managed',candidateCli]];
  const rows=[];
  for(const [mode,cli] of modes){
    const profile=join(fixtureRoot,mode);mkdirSync(profile,{recursive:true,mode:0o700});
    const env={...process.env,HOME:profile,USERPROFILE:profile,CAVEAT_HOME:join(profile,'.caveat'),XDG_STATE_HOME:join(profile,'state'),LOCALAPPDATA:join(profile,'state'),CLAUDE_CONFIG_DIR:join(profile,'.claude'),CODEX_HOME:join(profile,'.codex'),GROK_HOME:join(profile,'.grok'),CURSOR_HOME:join(profile,'.cursor')};
    writeFileSync(join(profile,'.caveatrc.json'),JSON.stringify({knowledgeRepo:'own',runtimeErrors:true}),{mode:0o600});
    const run=(script,args,input,limit=5000)=>{
      const start=performance.now();const x=spawnSync(process.execPath,[script,...args],{env,cwd:profile,input,encoding:'utf8',timeout:limit,maxBuffer:1024*1024});
      assert.equal(x.status,0,`${mode} ${args.join(' ')}: ${x.error?.message??x.stderr}`);
      assert.ok(!/store_unavailable|\[caveat:fatal\]/.test(x.stderr),x.stderr);
      return {elapsedMs:Math.round(performance.now()-start),stdout:x.stdout,stderrBytes:Buffer.byteLength(x.stderr),childLimitMs:limit};
    };
    const version=run(cli,['--version']).stdout.trim();assert.equal(version,mode==='old-direct'?'0.20.3':candidateVersion);
    // Ordinary product configuration/init, all paths belong to this fixture.
    run(candidateCli,['init','--yes'],undefined,60000);
    let entry=cli;
    if(mode==='candidate-managed'){
      const staged=JSON.parse(run(candidateCli,['deployment','stage','--json'],undefined,60000).stdout);
      run(candidateCli,['deployment','activate',staged.release,'--json'],undefined,60000);entry=staged.launcher;
    }
    for(const event of ['user-prompt-submit','post-tool-use','stop']){
      const input=JSON.stringify({session_id:'caveat-managed-normal-timing',cwd:profile,prompt:'ordinary prompt without matching entries',tool_name:'Read',tool_input:{file_path:'example.txt'},tool_response:'ordinary successful result'})+'\n';
      for(let iteration=0;iteration<3;iteration++){
        const x=run(entry,['codex-hook',event],input);
        rows.push({mode,version,event,phase:iteration===0?'first-in-fixture':'repeat',iteration,elapsedMs:x.elapsedMs,childLimitMs:x.childLimitMs,stdout:x.stdout,stderrBytes:x.stderrBytes});
      }
    }
  }
  for(const event of ['user-prompt-submit','post-tool-use','stop']){
    const eventRows=rows.filter(row=>row.event===event);assert.ok(eventRows.every(row=>row.stdout===eventRows[0].stdout),'ordinary hook output changed');
  }
  return {status:'ok',runtimeErrors:true,fixtureProfile:true,scope:'same host and Node; first/repeat fixture invocations, OS cache not reset',modes:3,rows:rows.map(({stdout,...row})=>({...row,stdoutBytes:Buffer.byteLength(stdout)})),realUserConfigWrites:0,trustWrites:0,modelCalls:0};
}
