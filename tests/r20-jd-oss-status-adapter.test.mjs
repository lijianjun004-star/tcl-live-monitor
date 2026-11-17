import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeJdOssStatus,summarizeJdOssScan} from '../probes/r20/jd-oss-status-adapter.mjs';

const now='2026-11-10T12:00:00.000Z';
const sample=()=>({
 platform:'jd',source_method:'JD_VISIBLE_SOURCE_STATUS',access_result:'OK',http_status:200,
 observed_at:'2026-11-10T11:58:00.000Z',
 public_anchor_id:'999887766',public_anchor_name:'示例主播（纯离线模拟）',
 verified_profile_url:'https://m.jd.com/anchor/sample',anchor_identity_confirmed:true,
 room_to_anchor_match:true,live_id:'45583477',status_code:1,is_live:true,room_live_ui_observed:true
});
const run=(v,opts={})=>normalizeJdOssStatus(v,{now,...opts});
test('only fresh identity corroborated LIVE with status_code=1 passes',()=>{
 const r=run(sample());
 assert.equal(r.state,'LIVE');assert.equal(r.live_id,'45583477');
 assert.equal(r.source_attested,true);assert.equal(r.identity_attested,true);
 assert.equal(r.eligible_for_opening_rate,false);
 assert.equal(r.negative_offline_attested,false);
});
test('historical 2026 JD link cannot be LIVE now even if API returns status',()=>{
 const i=sample();i.observed_at='2026-05-24T11:00:00.000Z';
 const r=run(i);
 assert.equal(r.state,'UNKNOWN');assert.equal(r.reason,'STALE_OR_FUTURE_EVIDENCE');
});
test('upstream is_live=false is UNKNOWN not offline',()=>{
 const i=sample();i.is_live=false;i.status_code=0;
 assert.equal(run(i).state,'UNKNOWN');
 assert.equal(run(i).negative_offline_attested,false);
});
test('status=1 without verified room UI is UNKNOWN',()=>{
 const i=sample();i.room_live_ui_observed=false;
 assert.equal(run(i).state,'UNKNOWN');
});
test('is_live=true without actual status=1 is UNKNOWN',()=>{
 const i=sample();i.status_code=null;
 assert.equal(run(i).state,'UNKNOWN');
});
test('missing liveId cannot prove any LIVE',()=>{
 const i=sample();i.live_id=null;
 assert.equal(run(i).state,'UNKNOWN');
});
test('missing or ambiguous account identity is UNKNOWN',()=>{
 for(const change of [
  {anchor_identity_confirmed:false},{room_to_anchor_match:false},
  {public_anchor_id:null},{public_anchor_name:''},{verified_profile_url:null}
 ]){
  const r=run({...sample(),...change});
  assert.equal(r.state,'UNKNOWN');assert.equal(r.identity_attested,false);
 }
});
test('current access blockers stop, never counted offline',()=>{
 for(const access_result of ['LOGIN_REQUIRED','CAPTCHA','HTTP_403','HTTP_429','SECURITY_CHALLENGE']){
  const r=run({...sample(),access_result});
  assert.equal(r.state,'UNKNOWN');assert.equal(r.blocked,true);
  assert.equal(r.live_id,null);assert.equal(r.source_attested,false);
 }
});
test('upstream exceptions and incomplete responses do not appear OFFLINE',()=>{
 for(const i of [null,{}, {...sample(),access_result:'TIMEOUT'}, {...sample(),http_status:500},
  {...sample(),platform:'douyin'}, {...sample(),source_method:'UNVERIFIED_API'}]){
  const r=run(i);
  assert.equal(r.state,'UNKNOWN');assert.equal(r.source_attested,false);
 }
});
test('stale or future timestamp cannot promote LIVE',()=>{
 for(const observed_at of ['2026-11-10T11:49:00.000Z','2026-11-10T12:02:00.000Z','2026-11-31T12:00:00.000Z','bad']){
  const r=run({...sample(),observed_at});
  assert.equal(r.state,'UNKNOWN');assert.equal(r.source_attested,false);
 }
});
test('no recording URL, tokens, cookies or private source fields leak',()=>{
 const r=run({...sample(),cookie:'TOKEN',flv_url:'https://media/?token=secret',headers:{Authorization:'secret'}});
 const text=JSON.stringify(r);
 assert.ok(!text.includes('secret'));assert.ok(!text.includes('TOKEN'));
 assert.equal(r.recording_url_excluded,true);
});
test('safe summary stays no rate even with a positive current LIVE',()=>{
 const r=summarizeJdOssScan([run(sample()),run({...sample(),status_code:0,is_live:false})]);
 assert.equal(r.counts.LIVE,1);assert.equal(r.counts.UNKNOWN,1);
 assert.equal(r.opening_rate_percent,null);assert.equal(r.offline_validated,false);
 assert.equal(r.eligible_for_production,false);
});
test('rejects fake OFFLINE record in summary',()=>{
 assert.throws(()=>summarizeJdOssScan([{state:'OFFLINE',eligible_for_opening_rate:false}]),/INVALID/);
});
