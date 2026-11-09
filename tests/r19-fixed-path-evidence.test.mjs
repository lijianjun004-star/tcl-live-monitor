import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {auditFixedPathEvidence} from '../probes/r19/audit-fixed-path-evidence.mjs';

const json=url=>JSON.parse(fs.readFileSync(new URL(url,import.meta.url),'utf8'));
const registry=json('../config/r19-douyin-tcl-ffalcon-registry.json');
const evidence=json('../docs/r19/evidence/2026-11-09-three-fixed-path-browser-checks.json');
const clone=()=>structuredClone(evidence);

test('3 browser runs match stable registry; 2 historical LIVE and 1 UNKNOWN',()=>{
 const out=auditFixedPathEvidence(registry,evidence);
 assert.equal(out.records.length,3);
 assert.equal(out.historical_live_observations,2);
 assert.equal(out.historical_unknown_observations,1);
 assert.equal(out.current_live_claims,0);
 assert.equal(out.current_offline_claims,0);
 assert.equal(out.precise_stream_duration_known,false);
 assert.equal(out.ongoing_monitor_enabled,false);
});
test('all records remain current UNKNOWN even after verified past LIVE',()=>{
 const out=auditFixedPathEvidence(registry,evidence);
 assert.ok(out.records.every(x=>x.current_state==='UNKNOWN'));
 assert.ok(out.records.every(x=>x.time_precision==='DATE_ONLY'));
});
test('air headquarters attribution needs review, not corporate ownership assumption',()=>{
 const out=auditFixedPathEvidence(registry,evidence);
 const t=out.records.find(x=>x.account_key==='tcl-douyin-air-direct');
 assert.equal(t.business_ownership_review,'PENDING');
 assert.equal(t.blocker,'AUTH_REQUIRED');
 assert.equal(t.has_room_confirmation,false);
});
test('monitor and home appliances are independent identities',()=>{
 const out=auditFixedPathEvidence(registry,evidence);
 const two=out.records.filter(x=>x.account_key.startsWith('ffalcon-'));
 assert.equal(two.length,2);
 assert.notEqual(two[0].captured_dynamic_room_id,two[1].captured_dynamic_room_id);
});
test('editing secUid to another known account is rejected',()=>{
 const bad=clone();bad.runs[0].sec_uid=registry.targets.find(x=>x.key==='ffalcon-douyin-tv-flagship').sec_uid;
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/ACCOUNT_IDENTITY_MISMATCH/);
});
test('route is not interchangeable with dynamic room ID',()=>{
 const bad=clone();bad.runs[0].dynamic_room_id_from_profile_link=bad.runs[0].live_route_id;
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/BAD_ROUTE_OR_SESSION_ID/);
});
test('requested link must originate from verified account live route',()=>{
 const bad=clone();bad.runs[0].requested_live_url='https://live.douyin.com/988541363148?room_id=7706010457504811786';
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/REQUESTED_ROOM_LINK_MISMATCH/);
});
test('canonical redirect may drop room query only on same route',()=>{
 const out=auditFixedPathEvidence(registry,evidence);
 assert.equal(out.historical_live_observations,2);
 const bad=clone();bad.runs[0].final_live_url='https://live.douyin.com/988541363148';
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/LIVE_WITHOUT_TWO_PAGE_EVIDENCE/);
});
test('historical browser run cannot be counted twice',()=>{
 const bad=clone();bad.runs[1].source_run_url=bad.runs[0].source_run_url;
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/DUPLICATE_BROWSER_RUN/);
});
test('two-page verified LIVE requires actual UI and no block',()=>{
 const bad=clone();bad.runs[0].live_ui_verified=false;
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/LIVE_WITHOUT_TWO_PAGE_EVIDENCE/);
 const block=clone();block.runs[1].blocked=true;
 assert.throws(()=>auditFixedPathEvidence(registry,block),/LIVE_WITHOUT_TWO_PAGE_EVIDENCE/);
});
test('without room access, blocked record cannot be called LIVE',()=>{
 const bad=clone();bad.runs[2].status_at_observation='LIVE';
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/LIVE_WITHOUT_TWO_PAGE_EVIDENCE/);
});
test('OFFLINE is not promoted from lack of live confirmation',()=>{
 const bad=clone();bad.runs[2].status_at_observation='OFFLINE';
 assert.throws(()=>auditFixedPathEvidence(registry,bad),/UNVALIDATED_OFFLINE_STATUS/);
});
test('raw untrusted source link or missing provenance is rejected',()=>{
 const a=clone();a.runs[0].source_run_url='https://evil.example/runs/id';
 assert.throws(()=>auditFixedPathEvidence(registry,a),/INVALID_BROWSER_RUN_URL/);
 const b=clone();b.runs[0].current_room_payload_attested=true;
 assert.throws(()=>auditFixedPathEvidence(registry,b),/MISSING_PAYLOAD_PROVENANCE/);
});
