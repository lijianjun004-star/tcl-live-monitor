#!/usr/bin/env node
/** R1.9 local roster/check manifest. No network, login, or automatic jobs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRegistry,planHourlyDouyinChecks,planManualDouyinCheck,classifyFreshProfileCapture} from './douyin-first.mjs';

const args=process.argv.slice(2);
const val=(flag,defaultValue)=>{const i=args.indexOf(flag);if(i<0)return defaultValue;if(!args[i+1]||args[i+1].startsWith('--'))throw Error('MISSING_'+flag);return args[i+1];};
const flags=new Set(['--mode','--at','--key','--request-id','--snapshot-file','--out']);
for(const token of args)if(token.startsWith('--')&&!flags.has(token))throw Error('UNKNOWN_FLAG_'+token);
const mode=val('--mode','hourly');
if(!['hourly','manual'].includes(mode))throw Error('INVALID_MODE');
const at=new Date(val('--at',new Date().toISOString())).toISOString();
const key=val('--key',null),snapshotFile=val('--snapshot-file',null);
const source=fileURLToPath(new URL('../../config/r19-douyin-tcl-ffalcon-registry.json',import.meta.url));
const registry=JSON.parse(await fs.readFile(source,'utf8'));
validateRegistry(registry);
const target=registry.targets.find(t=>t.key===key);
if(key&&!target)throw Error('UNKNOWN_ACCOUNT_KEY');
if(mode==='manual'&&!target)throw Error('MANUAL_NEEDS_KEY');
if(snapshotFile&&!target)throw Error('CAPTURE_NEEDS_KEY');
const checks=mode==='hourly'?planHourlyDouyinChecks(registry,at).filter(c=>!key||c.account_key===key):
  [planManualDouyinCheck(target,at,val('--request-id','r19-manual-'+at))];
const capture=snapshotFile?JSON.parse(await fs.readFile(path.resolve(snapshotFile),'utf8')):null;
const observations=capture?[classifyFreshProfileCapture(capture,target,{now:at})]:[];
const report={schema_version:19,created_at:at,mode,scheduled_checks:checks,
 source_connected:false,live_data_fetched_by_cli:false,
 historic_profile_badges_not_reused_as_realtime:true,observations,
 note:'This command only plans checks and optionally parses a supplied public-page snapshot. No Douyin network request or cron is made.'};
const out=path.resolve(val('--out','r19-douyin-report.json'));
await fs.mkdir(path.dirname(out),{recursive:true});
await fs.writeFile(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({targets:checks.length,snapshot_parsed:observations.length,
 realtime_observed_by_this_command:false,file:out}));
