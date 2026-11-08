#!/usr/bin/env node
/** Explicit single-shot experiment. There is no scheduler daemon or production cron. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCheck } from './core/scheduler.mjs';
import { runCheck } from './core/monitor.mjs';
import { DurableStore } from './store/index.mjs';
import { buildReport, renderReport } from './report.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => {const i=args.indexOf(flag);if(i<0)return fallback;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`Missing ${flag}`);return args[i+1];};
const flags = new Set(['--out-dir','--mode','--request-id','--planned-at','--actual-at','--public-page','--browser-session','--profile-dir','--headless']);
for (const a of args) if(a.startsWith('--')&&!flags.has(a)) throw Error(`Unknown option ${a}`);
if(args.includes('--public-page')&&args.includes('--browser-session'))throw Error('Choose one source');
const out = path.resolve(value('--out-dir','r18-output'));
const store = new DurableStore(path.join(out, 'store'));
const check = createCheck({ mode:value('--mode','manual'),request_id:value('--request-id',undefined),
  planned_check_at:value('--planned-at',undefined),actual_check_at:value('--actual-at',new Date().toISOString()) });
let adapter = async () => ({state:'UNKNOWN',source_attested:false,failure_code:'NO_VALID_TARGET_EVIDENCE',source_type:'NO_SOURCE'});
if(args.includes('--public-page')) adapter = (await import('./sources/tmall/index.mjs')).observe;
if(args.includes('--browser-session')) {
  const { observeTmallSession } = await import('./browser/tmall-session.mjs');
  adapter = options => observeTmallSession({...options,profileDir:value('--profile-dir',undefined),headless:args.includes('--headless')});
}
const result = await runCheck({store,adapter,check});
const report = {...buildReport(result.snapshot),check_id:check.check_id,duplicate:result.duplicate,next_eligible_at:result.next_eligible_at??null};
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
await fs.writeFile(path.join(out,'report.html'),renderReport(report));
console.log(JSON.stringify({state:result.observation.state,failure_code:result.observation.failure_code,duplicate:result.duplicate,next_eligible_at:report.next_eligible_at,observations:report.observations.length,sessions:report.sessions.length}));
