import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileDouyinFourLayers,buildDouyinSessionEvents} from '../probes/r36/douyin-evidence-gate.mjs';
const SEC='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const ACCT={key:'ffalcon-douyin-tv-flagship',profileUrl:'https://www.douyin.com/user/'+SEC,scopeApproved:true,scoringEligible:false};
const opsRooms=[{roomId:'17',shopId:'18',platform:'douyin'},{roomId:'19',shopId:'20',platform:'dy'}];
const checkedAt='2026-11-11T10:00:00Z';
const row={opsRoomId:'17',opsShopId:'18',publicSecUid:SEC,publicLiveRoomId:'999777',accountKey:ACCT.key,observedAt:checkedAt,reviewApproved:true,
  proofs:[{kind:'OPS_ROOM_SHOP',ref:'RUN43015295953',observedAt:checkedAt},{kind:'PUBLIC_ACCOUNT_ROOM',ref:'RUN43015156078',observedAt:checkedAt},{kind:'CROSS_SYSTEM_BRIDGE',ref:'MANUALREVIEW001',observedAt:checkedAt}]};
const make=(rows=[])=>reconcileDouyinFourLayers({opsRooms,accounts:[ACCT],evidenceRows:rows});
const obs=(t, extra={})=>({opsRoomId:'17',accountKey:ACCT.key,checkedAt:'2026-11-11T'+t+'Z',state:'LIVE',publicLiveRoomId:'999777',profileIdentityVerified:true,roomIdentityVerified:true,...extra});
const run=(observations,identityReport=make([row]))=>buildDouyinSessionEvents({observations,identityReport});

test('no bridge evidence => both internal rooms UNVERIFIED, zero scoring',()=>{let r=make();assert.equal(r.verifiedLinks,0);assert.equal(r.links.length,2);assert.equal(r.formalFullDurationRatePercent,null)});
test('independent three-way proof with review maps only exact internal room-shop and secUid',()=>{const r=make([row]);assert.equal(r.verifiedLinks,1);assert.equal(r.links.find(x=>x.opsRoomId==='17').status,'VERIFIED');assert.equal(r.unresolvedLinks,1)});
test('shop id is not a room id; mistaken shop and public secUid rejected',()=>{assert.equal(make([{...row,opsShopId:'17'}]).verifiedLinks,0);assert.equal(make([{...row,publicSecUid:SEC+'X'}]).verifiedLinks,0)});
test('partial evidence and no review cannot promote identity',()=>{assert.equal(make([{...row,proofs:row.proofs.slice(0,2)}]).verifiedLinks,0);assert.equal(make([{...row,reviewApproved:false}]).verifiedLinks,0)});
test('proofs must be independent, allowlisted, within seven days',()=>{const duplicate=row.proofs.map(x=>({...x,ref:'SAMESOURCE001'}));assert.equal(make([{...row,proofs:duplicate}]).verifiedLinks,0);assert.equal(make([{...row,proofs:[...row.proofs.slice(0,2),{...row.proofs[2],observedAt:'2025-01-01T00:00:00Z'}]}]).verifiedLinks,0)});
test('duplicate verified mappings collide instead of making two identities',()=>{const r=make([row,{...row,publicLiveRoomId:'999778'}]);assert.equal(r.verifiedLinks,0);assert.equal(r.conflicts.length,2)});
test('JD same numeric room ignored even when supplied',()=>{let r=reconcileDouyinFourLayers({opsRooms:[{roomId:'17',shopId:'18',platform:'jd'}],accounts:[ACCT],evidenceRows:[row]});assert.equal(r.verifiedLinks,0);assert.equal(r.links.length,0)});
test('unapproved external account is rejected',()=>{const r=reconcileDouyinFourLayers({opsRooms,accounts:[{...ACCT,scopeApproved:false}],evidenceRows:[row]});assert.equal(r.verifiedLinks,0)});
test('only verified double identity LIVE yields FIRST_SEEN_LIVE observation',()=>{const r=run([obs('10:00:00')]);assert.deepEqual(r.events.map(x=>x.type),['FIRST_SEEN_LIVE']);assert.equal(r.events[0].exactStartAt,null)});
test('unverified internal account has no LIVE event despite live status',()=>{const r=run([obs('10:00:00')],make());assert.equal(r.events.length,0);assert.equal(r.skipped[0].reason,'IDENTITY_NOT_VERIFIED')});
test('room page identity missing does not create LIVE',()=>{const r=run([obs('10:00:00',{roomIdentityVerified:false})]);assert.equal(r.events.length,0)});
test('UNKNOWN after LIVE starts gap once; never becomes OFFLINE',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{state:'UNKNOWN'}),obs('10:10:00',{state:'UNKNOWN'})]);assert.deepEqual(r.events.map(x=>x.type),['FIRST_SEEN_LIVE','UNKNOWN_GAP']);assert.equal(r.validatedOfflineCount,0)});
test('stale capture produces OFFLINE_CANDIDATE only',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{state:'UNKNOWN',offlineCandidate:true})]);assert.deepEqual(r.events.map(x=>x.type),['FIRST_SEEN_LIVE','UNKNOWN_GAP','OFFLINE_CANDIDATE']);assert.equal(r.events[2].exactEndAt,null)});
test('room ID change alone does not establish a new session',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{publicLiveRoomId:'999778'})]);assert.deepEqual(r.events.map(x=>x.type),['FIRST_SEEN_LIVE','UNKNOWN_GAP'])});
test('independent verified boundary evidence permits NEXT_SESSION_DETECTED',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{publicLiveRoomId:'999778',sessionBoundaryEvidence:{kind:'INDEPENDENT_NEW_SESSION',confirmed:true,ref:'SOURCEEVENT0001',observedAt:'2026-11-11T10:04:30Z'}})]);assert.deepEqual(r.events.map(x=>x.type),['FIRST_SEEN_LIVE','NEXT_SESSION_DETECTED']);assert.equal(r.events[1].possibleStartAfter,'2026-11-11T10:00:00.000Z')});
test('invalid or unconfirmed session boundary does not create new session',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{sessionBoundaryEvidence:{kind:'INDEPENDENT_NEW_SESSION',confirmed:false,ref:'SOURCEEVENT0001',observedAt:'2026-11-11T10:04:30Z'}})]);assert.equal(r.events.length,1)});
test('after UNKNOWN, LIVE without independent boundary does not fabricate new session',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{state:'UNKNOWN'}),obs('10:10:00')]);assert.deepEqual(r.events.map(x=>x.type),['FIRST_SEEN_LIVE','UNKNOWN_GAP'])});
test('output excludes raw secrets and personal payload extras',()=>{const r=run([obs('10:00:00',{bound_session_key:'PRIVATE_DO_NOT_PRINT',cookie:'PRIVATE_DO_NOT_PRINT'})]);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_DO_NOT_PRINT/)});
test('duplicate timestamps rejected and no double event',()=>{const r=run([obs('10:00:00'),obs('10:00:00')]);assert.equal(r.events.length,1);assert.equal(r.skipped.at(-1).reason,'DUPLICATE_TIMESTAMP')});
test('no OFFLINE or formal KPI regardless of input claims',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{state:'OFFLINE',offlineCandidate:false})]);assert.equal(r.validatedOfflineCount,0);assert.equal(r.formalFullDurationRatePercent,null)});
test('bridge expires after seven days and no events are promoted',()=>{const r=run([{...obs('10:00:00'),checkedAt:'2026-11-20T10:00:00Z'}]);assert.equal(r.events.length,0);assert.equal(r.skipped[0].reason,'BRIDGE_EVIDENCE_STALE_OR_NOT_YET_VALID')});
test('late boundary evidence cannot certify a new session',()=>{const r=run([obs('10:00:00'),obs('10:45:00',{publicLiveRoomId:'999778',sessionBoundaryEvidence:{kind:'INDEPENDENT_NEW_SESSION',confirmed:true,ref:'SOURCEEVENT0001',observedAt:'2026-11-11T10:00:00Z'}})]);assert.equal(r.events.filter(e=>e.type==='NEXT_SESSION_DETECTED').length,0)});

test('cross-account LIVE sample cannot borrow another room identity',()=>{const r=run([obs('10:00:00',{accountKey:'different-public-account'})]);assert.equal(r.events.length,0)});
test('verified next session allows follow-on LIVE checks on newly proven room ID',()=>{const r=run([obs('10:00:00'),obs('10:05:00',{publicLiveRoomId:'999778',sessionBoundaryEvidence:{kind:'INDEPENDENT_NEW_SESSION',confirmed:true,ref:'SOURCEEVENT0001',observedAt:'2026-11-11T10:04:30Z'}}),obs('10:10:00',{publicLiveRoomId:'999778'})]);assert.deepEqual(r.events.map(x=>x.type),['FIRST_SEEN_LIVE','NEXT_SESSION_DETECTED'])});
