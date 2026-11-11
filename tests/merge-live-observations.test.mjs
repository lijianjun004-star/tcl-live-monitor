import test from 'node:test';import assert from 'node:assert/strict';
import {mergeLiveObservations} from '../probes/lib/merge-live-observations.mjs';
const ts='2026-11-05T11:47:00.420Z',now=Date.parse(ts)+60_000;
const registry={entries:[{key:'ops:jd:16',source:'ops-platform',platform:'jd',opsRoomId:'16'},
 {key:'ops:jd:1',source:'ops-platform',platform:'jd',opsRoomId:'1',categoryMappingConflict:true},
 {key:'public:tmall:tcl',source:'public-probe-existing',platform:'tmall'},
 {key:'public:douyin:dy1',source:'public-probe-existing',platform:'douyin'},
 {key:'ops:douyin:4',source:'ops-history-unmapped',platform:'douyin'}]};
const jd={schemaVersion:2,source:'TCL_OPS_READ_ONLY',checkedAt:ts,rooms:[{roomId:'16',captureBound:true,agentAlive:true,status:'LIVE'},{roomId:'1',captureBound:true,agentAlive:true,status:'LIVE',categoryMappingConflict:true}]};
test('room 16 may be LIVE when fresh, conflicting JD room 1 must UNKNOWN',()=>{const r=mergeLiveObservations(registry,{jdReport:jd,now});assert.equal(r.rows[0].currentStatus,'LIVE');assert.equal(r.rows[1].currentStatus,'UNKNOWN')});
test('all stale sources become UNKNOWN',()=>{const r=mergeLiveObservations(registry,{jdReport:jd,now:now+3_600_000});assert.ok(r.rows.every(x=>x.currentStatus==='UNKNOWN'))});
test('unmapped ops Douyin never counted as another public account',()=>{const r=mergeLiveObservations(registry,{jdReport:jd,now});assert.equal(r.byPlatform.douyin.UNKNOWN,1)});
test('public account status only uses matching account key',()=>{
 const report={schemaVersion:1,observations:[{platform:'douyin',accountId:'dy1',at:now,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'}, {platform:'tmall',accountId:'different',at:now,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'}]};
 const r=mergeLiveObservations(registry,{publicReport:report,now});assert.equal(r.rows[3].currentStatus,'LIVE');assert.equal(r.rows[2].currentStatus,'UNKNOWN');
});
test('OFFLINE not accepted without confirmation',()=>{
 const report={schemaVersion:1,observations:[{platform:'douyin',accountId:'dy1',at:now,state:'OFFLINE',offlineEvidence:true,offlineRuleValidated:false}]};
 const r=mergeLiveObservations(registry,{publicReport:report,now});assert.equal(r.rows[3].currentStatus,'UNKNOWN');
});
test('conflicting same-time observations yield UNKNOWN',()=>{
 const report={schemaVersion:1,observations:[{platform:'douyin',accountId:'dy1',at:now,state:'LIVE',profileIdentityVerified:true,roomPageIdentityVerified:true,observedRoomId:'123456',checkedRoomId:'123456'}, {platform:'douyin',accountId:'dy1',at:now,state:'OFFLINE',offlineEvidence:true,offlineRuleValidated:true}]};
 assert.equal(mergeLiveObservations(registry,{publicReport:report,now}).rows[3].currentStatus,'UNKNOWN');
});
