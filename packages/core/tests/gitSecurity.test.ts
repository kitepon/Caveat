import {GitPluginError,TaskConfigurationError}from'simple-git';
import {it,expect,afterEach,vi}from'vitest';
import {mkdtempSync,writeFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{createGit}from'../src/gitRuntime.js';
let root:string;
afterEach(()=>{vi.unstubAllEnvs();if(root)rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
async function setup(){
 root=mkdtempSync(join(tmpdir(),'caveat-git-security-'));
 for(const k of Object.keys(process.env))if(/^(GIT_CONFIG|GIT_TRACE)/i.test(k)||/^(EDITOR|VISUAL|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_SSH_COMMAND|GIT_SSH|GIT_ASKPASS|SSH_ASKPASS|PAGER|GIT_PAGER|GIT_ALLOW_PROTOCOL|GIT_PROTOCOL_FROM_USER)$/i.test(k))vi.stubEnv(k,undefined);
 vi.stubEnv('HOME',root);vi.stubEnv('USERPROFILE',root);vi.stubEnv('XDG_CONFIG_HOME',join(root,'config'));
 await createGit(root).init();
}
async function guard(args:string[]){const error=await createGit(root).raw(args).catch(e=>e);expect(error).toBeInstanceOf(Error);expect(error instanceof GitPluginError || error instanceof TaskConfigurationError || error.message.startsWith('Unambiguous abbreviated options blocked with unsafe.allowAbbreviatedOptions setting:')).toBe(true);}
it('CVE-2026-102826 refuses inline include.path',async()=>{await setup();const p=join(root,'foreign.config');writeFileSync(p,'[user]\n name = harmless fixture\n');await guard(['-c',`include.path=${p}`,'status']);});
it('CVE-2026-102826 refuses conditional includeIf.path',async()=>{await setup();const p=join(root,'foreign.config');writeFileSync(p,'[user]\n name = harmless fixture\n');await guard(['-c',`includeIf.gitdir:/**.path=${p}`,'status']);});
it('CVE-2026-102828 refuses trailer command configuration',async()=>{await setup();await guard(['-c','trailer.fixture.cmd=fixture-never-invoked','status']);});
for(const flag of ['--receive-p','--exe'])it(`CVE-2026-102827 refuses abbreviated ${flag}`,async()=>{await setup();await guard(['push',`${flag}=fixture-never-invoked`,'--dry-run']);});
it('CVE-2026-102829 removes VISUAL from the actual Git child',async()=>{await setup();vi.stubEnv('TERM','xterm');vi.stubEnv('VISUAL','fixture-never-invoked');expect((await createGit(root).raw(['var','GIT_EDITOR'])).trim()).not.toContain('fixture-never-invoked');expect(process.env.VISUAL).toBe('fixture-never-invoked');});
it('refuses inherited SSH commands instead of automatically opting in',async()=>{await setup();vi.stubEnv('GIT_SSH_COMMAND','fixture-never-invoked');await expect((async()=>createGit(root).status())()).rejects.toMatchObject({code:'CAVEAT_GIT_ENV_UNSAFE'});});
it('refuses inherited GIT_CONFIG instead of automatically opting in',async()=>{await setup();vi.stubEnv('GIT_CONFIG_COUNT','1');vi.stubEnv('GIT_CONFIG_KEY_0','user.name');vi.stubEnv('GIT_CONFIG_VALUE_0','harmless fixture');await expect((async()=>createGit(root).status())()).rejects.toMatchObject({code:'CAVEAT_GIT_ENV_UNSAFE'});});
