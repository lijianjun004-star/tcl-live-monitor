import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PATH_VERSION,PATH_STEPS,findAccount,searchRoster,fixedOperationPath,nextAction} from '../probes/r19/operation-path.mjs';

const registry=JSON.parse(fs.readFileSync(new URL('../config/r19-douyin-tcl-ffalcon-registry.json',import.meta.url),'utf8'));
const root=fileURLToPath(new URL('../',import.meta.url));
const target=registry.targets.find(t=>t.key==='tcl-douyin-flagship');
const ff=registry.targets.find(t=>t.key==='ffalcon-douyin-monitor-flagship');
function cli(...args){
 return spawnSync(process.execPath,['probes/r19/path-cli.mjs',...args],{cwd:root,encoding:'utf8'});
}
test('stable path has 7 ordered stages, explicit UNKNOWN and no current room values',()=>{
 const p=fixedOperationPath(target);
 assert.equal(p.path_version,PATH_VERSION);
 assert.deepEqual(p.steps,PATH_STEPS);
 assert.equal(p.steps.length,7);
 assert.equal(p.profile_url,target.profile_url);
 assert.equal(p.live_query_url,null);
 assert.equal(p.current_live_route_id,null);
 assert.equal(p.current_dynamic_room_id,null);
 assert.equal(p.state_until_live_gate,'UNKNOWN');
 assert.equal(p.offline_rule,'NOT_VALIDATED_DO_NOT_INFER_OFFLINE');
 assert.equal(p.schedule,'MANUAL_ONLY_NO_CRON');
});
test('old route and old dynamic room remain historical only',()=>{
 const p=fixedOperationPath(target);
 assert.equal(p.historical_route_for_reference_only,'31878890513');
 assert.equal(p.current_dynamic_room_id,null);
 assert.equal(p.historic_profile_live_badge_not_current,true);
});
test('resolve by exact key, Douyin display ID or secUid to same account',()=>{
 for(const token of [target.key,target.display_douyin_id,target.sec_uid])
  assert.equal(findAccount(registry,token).sec_uid,target.sec_uid);
});
test('new FFALCON monitor account can be resolved in one step without search',()=>{
 assert.equal(findAccount(registry,'33935558506').sec_uid,ff.sec_uid);
 assert.equal(fixedOperationPath(ff).profile_url,'https://www.douyin.com/user/'+ff.sec_uid);
});
test('similarly named FFALCON accounts must not collapse',()=>{
 const rows=searchRoster(registry,'雷鸟');
 assert.equal(rows.length,3);
 assert.equal(new Set(rows.map(x=>x.sec_uid)).size,3);
});
test('findAccount refuses nickname-only or empty ambiguous search',()=>{
 assert.throws(()=>findAccount(registry,'雷鸟'),/ACCOUNT_NOT_IN_ROSTER/);
 assert.throws(()=>findAccount(registry,''),/ACCOUNT_IDENTIFIER_REQUIRED/);
 assert.throws(()=>findAccount(registry,'not-real-account'),/ACCOUNT_NOT_IN_ROSTER/);
});
test('first party scope excludes AR and independent dealer by default',()=>{
 assert.equal(searchRoster(registry,'').length,12);
 assert.equal(searchRoster(registry,'',{includeAdjacentBusinesses:true}).length,14);
});
test('no badge or suspected offline must NEVER become OFFLINE',()=>{
 assert.deepEqual(nextAction({stage:'PROFILE_VERIFIED',result:'NO_BADGE'}),
  {step:'STOP_NO_OFFLINE_ASSERTION',state:'UNKNOWN',retry:false});
 assert.equal(nextAction({stage:'ROOM_VERIFIED',result:'OFFLINE'}).state,'UNKNOWN');
});
test('CAPTCHA and AUTH_REQUIRED cause stop with no automatic retry',()=>{
 for(const reason of ['CAPTCHA','AUTH_REQUIRED','RATE_LIMIT','SECURITY_CHALLENGE','TIMEOUT','NETWORK_ERROR']){
  const action=nextAction({stage:'PROFILE_VERIFIED',result:reason});
  assert.equal(action.step,'STOP');assert.equal(action.state,'UNKNOWN');
  assert.equal(action.retry,false);
 }
});
test('profile fresh badge step leads to current live link not historical route',()=>{
 assert.equal(nextAction({stage:'START'}).step,'OPEN_EXACT_PROFILE');
 assert.equal(nextAction({stage:'PROFILE_VERIFIED',result:'FRESH_BADGE'}).step,'FOLLOW_CURRENT_PROFILE_LINK');
 assert.equal(nextAction({stage:'ROOM_VERIFIED',result:'LIVE'}).step,'RECORD_LIVE_OBSERVATION');
});
test('identity mismatch stops, no fuzzy recovery',()=>{
 assert.equal(nextAction({stage:'PROFILE_IDENTITY_MISMATCH'}).step,'STOP_AND_FLAG_IDENTITY_CONFLICT');
});
test('CLI exact key creates deterministic one-account guide without any live state',()=>{
 const r=cli('--key','tcl-douyin-flagship');
 assert.equal(r.status,0,r.stderr);
 const p=JSON.parse(r.stdout);
 assert.equal(p.kind,'ACCOUNT_FIXED_PATH');
 assert.equal(p.path.account_key,'tcl-douyin-flagship');
 assert.equal(p.path.current_dynamic_room_id,null);
});
test('CLI local brand search returns separate choices and warns ambiguity',()=>{
 const r=cli('--search','雷鸟');
 assert.equal(r.status,0,r.stderr);
 const p=JSON.parse(r.stdout);
 assert.equal(p.matches,3);assert.equal(p.ambiguous,true);assert.equal(p.network_requests,0);
});
test('CLI --list enumerates 12 primary accounts, no network',()=>{
 const r=cli('--list');
 assert.equal(r.status,0,r.stderr);
 const p=JSON.parse(r.stdout);
 assert.equal(p.matches,12);
 assert.equal(p.network_requests,0);
});
test('CLI rejects missing key and invalid flags instead of searching the internet',()=>{
 assert.notEqual(cli('--key').status,0);
 assert.notEqual(cli('--unknown').status,0);
 assert.notEqual(cli('--key','tcl-douyin-flagship','--search','TCL').status,0);
});
