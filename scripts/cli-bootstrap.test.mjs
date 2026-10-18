import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const launcher = new URL('../apps/cli/src/bootstrap.mjs', import.meta.url);
function fixture(source) {
  const root = mkdtempSync(join(tmpdir(), 'caveat-bootstrap-'));
  copyFileSync(launcher, join(root, 'caveat.js'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'index.js'), source);
  return root;
}
function invoke(root, args = [], extra = {}) {
  return spawnSync(process.execPath, [join(root, 'caveat.js'), ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' }, ...extra,
  });
}

test('normal launcher enables SQLite when needed, passes argv/cwd/env and emits no extra public bytes', () => {
  const root = fixture("process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),value:process.env.CAVEAT_BOOTSTRAP_TEST,sqlite:!!process.getBuiltinModule('node:sqlite'),flags:process.execArgv})+'\\n');");
  try {
    const args=['--argument','space value','ノード','literal$()`'];
    const result=invoke(root,args,{cwd:root,env:{...process.env,NODE_OPTIONS:'',CAVEAT_BOOTSTRAP_TEST:'fixture'}});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
    const output=JSON.parse(result.stdout);assert.deepEqual(output.args,args);assert.equal(output.cwd,root);
    assert.equal(output.value,'fixture');assert.equal(output.sqlite,true);
    const alreadyAvailable=!!process.getBuiltinModule('node:sqlite');
    assert.equal(output.flags.includes('--experimental-sqlite'),!alreadyAvailable);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('normal launcher preserves stdin, stdout, stderr and nonzero exit', () => {
  const root=fixture("let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{process.stdout.write(input);process.stderr.write('fixture error\\n');process.exitCode=23;});");
  try {
    const result=invoke(root,[],{input:'unchanged input\n'});
    assert.equal(result.status,23);assert.equal(result.stdout,'unchanged input\n');assert.equal(result.stderr,'fixture error\n');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('explicit SQLite disable in argv or NODE_OPTIONS is retained without enabling or re-exec loop', () => {
  const root=fixture("process.stdout.write(JSON.stringify({sqlite:!!process.getBuiltinModule('node:sqlite'),flags:process.execArgv})+'\\n');");
  try {
    const byArg=spawnSync(process.execPath,['--no-experimental-sqlite',join(root,'caveat.js')],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_OPTIONS:''}});
    assert.equal(byArg.status,0,byArg.stderr);assert.equal(JSON.parse(byArg.stdout).sqlite,false);
    assert.deepEqual(JSON.parse(byArg.stdout).flags,['--no-experimental-sqlite']);
    const byEnv=invoke(root,[],{env:{...process.env,NODE_OPTIONS:'--no-experimental-sqlite'}});
    assert.equal(byEnv.status,0,byEnv.stderr);assert.equal(JSON.parse(byEnv.stdout).sqlite,false);
    assert.equal(JSON.parse(byEnv.stdout).flags.includes('--experimental-sqlite'),false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

const sqliteSpellings = [
  ['--experimental_sqlite', true],
  ['--no_experimental_sqlite', false],
  ['--no-experimental_sqlite', false],
  ['--no_experimental-sqlite', false],
];
for (const [option, expected] of sqliteSpellings) {
  for (const location of ['argv', 'NODE_OPTIONS']) {
    test(`SQLite option spelling ${option} in ${location} is preserved`, () => {
      const root = fixture("process.stdout.write(JSON.stringify({sqlite:!!process.getBuiltinModule('node:sqlite'),flags:process.execArgv,options:process.env.NODE_OPTIONS})+'\\n');");
      try {
        const argv = location === 'argv' ? [option, join(root, 'caveat.js')] : [join(root, 'caveat.js')];
        const options = location === 'NODE_OPTIONS' ? option : '';
        const result = spawnSync(process.execPath, argv, {encoding:'utf8',timeout:10000,env:{...process.env,NODE_OPTIONS:options}});
        assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
        const output = JSON.parse(result.stdout);assert.equal(output.sqlite,expected);
        assert.deepEqual(output.flags,location === 'argv' ? [option] : []);
        assert.equal(output.options,options);
      } finally {rmSync(root,{recursive:true,force:true});}
    });
  }
}

test('existing Node argv options are forwarded and bootstrap initialization remains one-shot', () => {
  const root=fixture("process.stdout.write(JSON.stringify(process.execArgv)+'\\n');");
  try {
    const result=spawnSync(process.execPath,['--no-warnings',join(root,'caveat.js')],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_OPTIONS:''}});
    assert.equal(result.status,0,result.stderr);const flags=JSON.parse(result.stdout);
    assert.equal(flags.filter(x=>x==='--no-warnings').length,1);assert.ok(flags.filter(x=>x==='--experimental-sqlite').length<=1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('termination of the wrapper reaches the long-running child and cannot return success', async () => {
  const root=fixture("process.stdout.write('ready\\n');setInterval(()=>{},1000);");
  const child=spawn(process.execPath,[join(root,'caveat.js')],{stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:''}});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);
  try {
    const ready=await once(child.stdout,'data');assert.match(ready[0].toString(),/ready/);
    const closed=once(child,'close');child.kill('SIGTERM');const [code,signal]=await closed;
    assert.ok(signal==='SIGTERM'||(Number.isInteger(code)&&code!==0));
  } finally {clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(root,{recursive:true,force:true});}
});
