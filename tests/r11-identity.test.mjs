import test from 'node:test';import assert from 'node:assert/strict';
import {strictBoolean,stableKey,historicalRoomCheck,auditIdentity,gateSummary} from '../probes/lib/r11-identity.mjs';
const sec='MS4wLjABAAAAVozXF9jRtNt6k62dH8TZXld0RGpvIK8aZxEh3oWcBfM';
const dy={sourceKey:'tcl-douyin-flagship',platform:'douyin',sourceName:'TCL官方旗舰店',platformIdentityVerified:'true',
 identityVerified:'true',accountStableId:'douyin:secUid:'+sec,state:'LIVE',
 brandOwnershipVerified:'false',reliableMonitorPassed:'NOT_RUN',scoringEligible:'false (历史遗留true待复核)'};
const goodRoom={sourceKey:dy.sourceKey,verifiedLiveRoomOrStreamId:'31878890513',crossCheckStatus:'VERIFIED'};
test('strict bool never treats nonempty string false as true',()=>{assert.equal(strictBoolean('false'),false);assert.equal(strictBoolean('false (历史遗留true待复核)'),null);assert.equal(strictBoolean('1'),null);});
test('valid Douyin identity key is immutable secUid',()=>assert.equal(stableKey(dy),'douyin:secUid:'+sec));
test('JD store ID is not live account key',()=>assert.equal(stableKey({platform:'jd',accountStableId:'jd:mallShopId:721631'}),null));
test('JD internal stream never equals public liveId',()=>{const x={sourceKey:'jd-ops-1',platform:'jd(内部采集)',identityVerified:'internal-only',accountStableId:'jd:opsRoom:1'};assert.equal(auditIdentity([x],[{sourceKey:x.sourceKey,verifiedLiveRoomOrStreamId:'1',crossCheckStatus:'VERIFIED'}])[0].gate,'OPS_INTERNAL_ONLY');});
test('historical verified Douyin live room keeps historical-only time scope',()=>{const x=auditIdentity([dy],[goodRoom])[0];assert.equal(x.gate,'HISTORICAL_PUBLIC_ROOM_VERIFIED');assert.equal(x.historicalPublicRoomId,'31878890513');assert.equal(x.stateScope,'HISTORICAL_ONLY');});
test('LIVE badge without cross-verification does not prove room',()=>{const x=auditIdentity([dy],[{...goodRoom,crossCheckStatus:'LIVE_BADGE_ONLY_ROOM_UNVERIFIED_LAST_ROUND'}])[0];assert.equal(x.gate,'ACCOUNT_ONLY');assert.equal(x.roomCrossVerified,false);});
test('store name and URL may pass independently without liveId',()=>{const x=auditIdentity([{sourceKey:'store1',platform:'jd',sourceName:'TCL官方旗舰店'}],[],[{sourceKey:'store1',storeVerified:true,url:'https://mall.jd.com/shopLevel-721631.html'}])[0];assert.equal(x.gate,'STORE_ONLY');assert.equal(x.historicalPublicRoomId,'');assert.equal(x.scoringEligible,false);});
test('store failure does not prevent another store from passing',()=>{const x=auditIdentity([{sourceKey:'a',platform:'jd'},{sourceKey:'b',platform:'jd'}],[],[{sourceKey:'b',storeVerified:true,url:'https://mall.jd.com/index-619517.html'}]);assert.equal(x[0].gate,'UNVERIFIED_LEAD');assert.equal(x[1].gate,'STORE_ONLY');});
test('same immutable account, different nickname deduplicates',()=>{const x=auditIdentity([dy,{...dy,sourceKey:'alias',sourceName:'新名称'}],[goodRoom]);assert.equal(x[1].gate,'DUPLICATE_ACCOUNT_KEY');assert.equal(gateSummary(x).uniqueStableKeys,1);});
test('same name, different account IDs remain separate',()=>{const x=auditIdentity([dy,{...dy,sourceKey:'different',accountStableId:'douyin:secUid:MS4wLjABAAAAzzzzzzzzzzzzzzzzzzzzzzzzzzzz'}],[goodRoom]);assert.equal(gateSummary(x).uniqueStableKeys,2);});
test('refuted candidate never re-enters monitor',()=>{const x=auditIdentity([{...dy,identityVerified:'REFUTED'}],[goodRoom])[0];assert.equal(x.gate,'REFUTED');assert.equal(x.scoringEligible,false);});
test('failed/offline and UNKNOWN do not trigger scoring promotion',()=>{for(const state of ['UNKNOWN','OFFLINE','LIVE']){const x=auditIdentity([{...dy,state}],[goodRoom])[0];assert.equal(x.scoringEligible,false);assert.equal(x.priorState,state);}});
test('invalid room ID or wrong source key fails closed',()=>{assert.equal(historicalRoomCheck(dy,{...goodRoom,verifiedLiveRoomOrStreamId:'SKU-10'}).verified,false);assert.equal(historicalRoomCheck(dy,{...goodRoom,sourceKey:'other'}).verified,false);});
