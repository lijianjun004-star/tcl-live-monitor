#!/usr/bin/env node
/**
 * Deterministic Douyin account lookup; outputs current stable profile URL.
 * Does not visit Douyin, does not infer live status or schedule jobs.
 *
 * node probes/r19/path-cli.mjs --key tcl-douyin-flagship
 * node probes/r19/path-cli.mjs --search 雷鸟
 * node probes/r19/path-cli.mjs --list
 */
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {findAccount,searchRoster,fixedOperationPath,PATH_VERSION} from './operation-path.mjs';

const args=process.argv.slice(2);
const readArg=flag=>{
 const index=args.indexOf(flag);
 if(index<0)return null;
 const v=args[index+1];
 if(!v||v.startsWith('--'))throw Error('MISSING_VALUE_FOR_'+flag);
 return v;
};
const flags=new Set(['--key','--search','--list','--include-adjacent']);
for(const token of args)if(token.startsWith('--')&&!flags.has(token))throw Error('UNSUPPORTED_FLAG_'+token);
const key=readArg('--key'),search=readArg('--search'),list=args.includes('--list'),adjacent=args.includes('--include-adjacent');
if([Boolean(key),Boolean(search),list].filter(Boolean).length!==1)throw Error('CHOOSE_EXACTLY_ONE_OF_KEY_SEARCH_LIST');

const path=fileURLToPath(new URL('../../config/r19-douyin-tcl-ffalcon-registry.json',import.meta.url));
const roster=JSON.parse(await fs.readFile(path,'utf8'));
const choices={includeAdjacentBusinesses:adjacent};
let out;
if(key)out={kind:'ACCOUNT_FIXED_PATH',path:fixedOperationPath(findAccount(roster,key,choices))};
else {
 const results=searchRoster(roster,search??'',choices);
 out={
  kind:'LOCAL_ROSTER_SEARCH',
  path_version:PATH_VERSION,
  query:search??null,
  results:results.map(t=>({
   key:t.key,account_name:t.account_name,display_douyin_id:t.display_douyin_id,
   segment:t.business_segment,profile_url:t.profile_url, sec_uid:t.sec_uid
  })),
  matches:results.length,
  ambiguous:Boolean(search)&&results.length!==1,
  next:'Pick one exact key with --key before opening a profile',
  network_requests:0
 };
}
console.log(JSON.stringify(out,null,2));
