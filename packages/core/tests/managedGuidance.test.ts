vi.mock('node:fs', async original => { const actual = await original<typeof import('node:fs')>(); return {...actual,lstatSync:vi.fn(actual.lstatSync)}; });
import { expect, it } from 'vitest';
import { autoSyncNotification } from '../src/autoSync.js';
import { toolErrorReminderText, userPromptSubmitReminderText, stopReminderText } from '../src/claudeHooks.js';
const hit = {id:'fixture', source:'own', title:'fixture', symptomExcerpt:'fixture', confidence:'confirmed' as const, visibility:'private' as const, environment:{}};
const signals = {toolFailureCount:1,fileEditCounts:[],webSearchCount:0,webFetchCount:0,bashRetryCount:0,durationMinutes:1,errorSnippets:[],searchQueries:[]};
const rows = [
 ['sync failure', () => Reflect.apply(autoSyncNotification, undefined, [{community:[],own:{disposition:'fail',code:'UNKNOWN'}}, true]).text, 'caveat_sync'],
 ['sync backoff', () => Reflect.apply(autoSyncNotification, undefined, [{community:[],own:{disposition:'fail',degraded:true}}, true]).text, 'caveat_sync'],
 ['error show', () => Reflect.apply(toolErrorReminderText,undefined,[[hit],'native-cli',true]), 'caveat_get'],
 ['prompt show', () => Reflect.apply(userPromptSubmitReminderText,undefined,[[hit],'native-cli',true]), 'caveat_get'],
 ['stop related show', () => Reflect.apply(stopReminderText,undefined,[signals,[hit],'native-cli',true]), 'caveat_get'],
 ['stop update/index', () => Reflect.apply(stopReminderText,undefined,[signals,[hit],'native-cli',true]), 'caveat_update'],
 ['stop record/index', () => Reflect.apply(stopReminderText,undefined,[signals,[],'native-cli',true]), 'caveat_record'],
] as const;
for (const [name,render,tool] of rows) it(`managed guidance: ${name}`, () => {
 const text=render(); expect(text).toContain(tool); expect(text).not.toContain('mcp__caveat__'); expect(text).not.toMatch(/caveat (sync|show|index)\b/);
});

import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import * as fs from 'node:fs';import {vi} from 'vitest';
import {usesManagedGuidance} from '../src/managedGuidance.js';
it('uses the native user home, preserving absent npm installs and refusing broken/unknown managed fallbacks',()=>{
 const home=mkdtempSync(join(tmpdir(),'caveat-managed-guidance-'));
 try{
  expect(usesManagedGuidance(home)).toBe(false);
  const root=join(home,'.caveat-deploy','managed-v1');mkdirSync(root,{recursive:true});
  expect(usesManagedGuidance(home)).toBe(true);writeFileSync(join(root,'active.json'),'broken');expect(usesManagedGuidance(home)).toBe(true);
  mkdirSync(join(home,'.local','share','caveat','managed-v1'),{recursive:true});expect(usesManagedGuidance(home)).toBe(true);
  rmSync(join(home,'.caveat-deploy'),{recursive:true});expect(usesManagedGuidance(home)).toBe(true);
  const spy=vi.spyOn(fs,'lstatSync').mockImplementation(()=>{throw Object.assign(Error('not readable'),{code:'EACCES'});});
  try{expect(usesManagedGuidance(home)).toBe(true);}finally{spy.mockRestore();}
 }finally{rmSync(home,{recursive:true,force:true});}
});
it('keeps unmanaged native CLI guidance unchanged',()=>{
 expect(toolErrorReminderText([hit],'native-cli')).toContain('caveat show');
 expect(stopReminderText(signals,[hit],'native-cli')).toContain('caveat index');
 expect(autoSyncNotification({community:[],own:{disposition:'fail'}}).text).toContain('`caveat sync`');
});
