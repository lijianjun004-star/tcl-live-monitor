import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDouyin,inspectDouyinCatalog,inspectDouyinShops,inspectDouyinHeartbeat,
  evaluateDouyinRoom,douyinRegistrySummary,scanDouyinOps,summarizeDouyinGap
} from '../probes/r36/douyin-ops-parity.mjs';

const NOW=Date.parse('2026-11-11T08:30:00.000Z'), DATE='2026-11-11';
const ROOM={roomId:'17',shopId:'18',platform:'dy',category:'电视',captureBound:true};
const day={date:DATE,minute_count:50,latest_minute_ts:'2026-11-11T08:29:00.000Z',latest:{status:1},session_count:2};
const HB='2026-11-11T08:29:30.000Z';
const SEC='MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s';
const cfg={douyin:[{key:'ffalcon-douyin',profileUrl:'https://www.douyin.com/user/'+SEC,displayDouyinId:'83165143028',scopeApproved:true,scoringEligible:false}]};
const roomInput=(items,total=null)=>({...total===null?{}:{total},rooms:items});
const rawRoom=(override={})=>({platform:'dy',id:17,shop_id:18,category:'电视',bound_session_key:'NEVER_SERIALIZE_THIS_SECRET',...override});
const rawShop=(override={})=>({platform:'dy',id:18,name:'NOT_ALLOWED_TO_SERIALIZE',...override});
const source=(what,params)=>{
  if(what==='/api/capture/rooms')return roomInput([rawRoom(),{platform:'jd',id:17,shop_id:2,bound_session_key:'jdsecret'}],2);
  if(what==='/api/shops')return [rawShop(),{platform:'jd',id:2}];
  if(what==='/api/assistant/active-rooms')return {rooms:[{platform:'dy',id:17,last_heartbeat_at:HB},{platform:'jd',id:17,last_heartbeat_at:'2020-01-01T00:00:00Z'}]};
  if(what==='/api/capture/room-overview/daily'){
    assert.deepEqual(params,{start_date:DATE,end_date:DATE,platform:'dy',live_room_id:'17'});
    return {days:[day]};
  }
  throw Error('NO_UNDOCUMENTED_ROUTES_ALLOWED');
};

test('source platform aliases are explicitly selected; JD and arbitrary tags excluded',()=>{
  assert.equal(isDouyin('dy'),true);
  assert.equal(isDouyin('douyin'),true);
  assert.equal(isDouyin('抖音'),true);
  assert.equal(isDouyin('jd'),false);
  assert.equal(isDouyin('douyinx'),false);
});
test('catalog never confuses JD room numeric ID with Douyin source ID',()=>{
 const x=inspectDouyinCatalog(roomInput([rawRoom(),{platform:'jd',id:17,shop_id:999}],2));
 assert.equal(x.rooms.length,1);
 assert.equal(x.rooms[0].roomId,'17');
 assert.equal(x.rooms[0].platform,'dy');
 assert.equal(x.catalogComplete,true);
 assert.equal(JSON.stringify(x).includes('NEVER_SERIALIZE_THIS_SECRET'),false);
});
test('no declared total is not exhaustive proof',()=>{
 const x=inspectDouyinCatalog(roomInput([rawRoom()]));
 assert.equal(x.catalogComplete,false);
 assert.equal(x.catalogReason,'TOTAL_NOT_DECLARED');
});
test('server pagination or truncated total cannot become full roster',()=>{
 assert.equal(inspectDouyinCatalog({...roomInput([rawRoom()],2)}).catalogComplete,false);
 assert.equal(inspectDouyinCatalog({...roomInput([rawRoom()],1),has_more:true}).catalogComplete,false);
 assert.equal(inspectDouyinCatalog({...roomInput([rawRoom()],1),next_cursor:'a'}).catalogComplete,false);
});
test('duplicate or invalid source rooms stay audit warnings, never counted twice',()=>{
 const a=inspectDouyinCatalog(roomInput([rawRoom(),rawRoom(),rawRoom({id:'javascript:'})],3));
 assert.equal(a.rooms.length,1);
 assert.ok(a.warnings.includes('DOUYIN_SOURCE_ROOM_DUPLICATE'));
 assert.ok(a.warnings.includes('DOUYIN_SOURCE_ROOM_ID_INVALID'));
 assert.equal(a.catalogComplete,false);
});
test('shop id link is only exact same-platform source match; no guessed cross-platform identity',()=>{
 const shops=inspectDouyinShops([rawShop(),{platform:'jd',id:18}]);
 assert.deepEqual(shops,[{shopId:'18',platform:'dy'}]);
 assert.equal(JSON.stringify(shops).includes('NOT_ALLOWED_TO_SERIALIZE'),false);
 assert.throws(()=>inspectDouyinShops([rawShop(),rawShop()]),/DOUYIN_SHOP_DUPLICATE/);
});
test('heartbeat must explicitly match Douyin platform, not same numeric JD room',()=>{
 const h=inspectDouyinHeartbeat({rooms:[{platform:'jd',id:17,last_heartbeat_at:HB},{platform:'dy',id:17,last_heartbeat_at:'2026-11-11T08:29:21Z'}]});
 assert.equal(h.get('17'),'2026-11-11T08:29:21Z');
 assert.throws(()=>inspectDouyinHeartbeat({rooms:[{platform:'dy',id:17,last_heartbeat_at:HB},{platform:'dy',id:17,last_heartbeat_at:'2000-01-01T00:00:00Z'}]}),/DOUYIN_HEARTBEAT_DUPLICATE_CONFLICT/);
});
test('trusted fresh TCL OPS minute and fresh capture agent yield INTERNAL LIVE only',()=>{
 const r=evaluateDouyinRoom({room:ROOM,day,heartbeatAt:HB,date:DATE,at:NOW});
 assert.equal(r.status,'LIVE');
 assert.equal(r.publicAccountMatched,false);
 assert.equal(r.exactStartAt,null);
 assert.equal(r.exactEndAt,null);
 assert.match(r.statusSource,/INTERNAL_UNVERIFIED/);
});
test('no capture binding or no valid heartbeat does not claim Douyin LIVE',()=>{
 const unbound=evaluateDouyinRoom({room:{...ROOM,captureBound:false},day,heartbeatAt:HB,date:DATE,at:NOW});
 const stale=evaluateDouyinRoom({room:ROOM,day,heartbeatAt:'2020-01-01T00:00:00Z',date:DATE,at:NOW});
 assert.equal(unbound.status,'UNKNOWN');assert.equal(unbound.reason,'CAPTURE_UNBOUND');
 assert.equal(stale.status,'UNKNOWN');
});
test('stale minute plus healthy capture is OFFLINE candidate only',()=>{
 const old={...day,latest_minute_ts:'2026-11-11T07:50:00.000Z'};
 const r=evaluateDouyinRoom({room:ROOM,day:old,heartbeatAt:HB,date:DATE,at:NOW});
 assert.equal(r.status,'UNKNOWN');
 assert.equal(r.offlineCandidate,true);
});
test('historical 2026-10-21 page data cannot claim current LIVE',()=>{
 const r=evaluateDouyinRoom({room:ROOM,day:{...day,date:'2026-10-21'},heartbeatAt:HB,date:'2026-10-21',at:NOW});
 assert.equal(r.status,'UNKNOWN');
 assert.equal(r.reason,'HISTORICAL_DATE_CANNOT_PROVE_CURRENT_STATUS');
});
test('no numeric count, no current snapshot, no HB API => UNKNOWN',()=>{
 assert.equal(evaluateDouyinRoom({room:ROOM,day:{date:DATE,minute_count:'50'},heartbeatAt:HB,date:DATE,at:NOW}).status,'UNKNOWN');
 assert.equal(evaluateDouyinRoom({room:ROOM,day,heartbeatAvailable:false,date:DATE,at:NOW}).status,'UNKNOWN');
 assert.equal(evaluateDouyinRoom({room:ROOM,day:null,date:DATE,at:NOW}).status,'UNKNOWN');
});
test('minutes delta is source counter, not exact livestream duration',()=>{
 const prev={roomId:'17',date:DATE,at:NOW-600000,minuteCount:48};
 const r=evaluateDouyinRoom({room:ROOM,day,heartbeatAt:HB,date:DATE,at:NOW,previous:prev});
 assert.equal(r.minutesDelta,2);
 assert.equal(r.exactStartAt,null);assert.equal(r.exactEndAt,null);
});
test('approved registry scoring permission is not promoted by internal census',()=>{
 const x=douyinRegistrySummary(cfg);
 assert.equal(x.approvedAccounts,1);
 assert.equal(x.approvedScoringAccounts,0);
 assert.equal(x.publicIdentityLinkedToOpsRooms,false);
 assert.throws(()=>douyinRegistrySummary({douyin:[cfg.douyin[0],cfg.douyin[0]]}),/DOUYIN_REGISTRY_DUPLICATE/);
});
test('end-to-end sanitized scan uses ONLY 4 previously documented GET endpoints',async()=>{
 const used=[];
 const report=await scanDouyinOps({
   reader:async (path,params)=>{used.push(path);return source(path,params)},
   config:cfg,at:NOW});
 assert.deepEqual(used,['/api/capture/rooms','/api/shops','/api/assistant/active-rooms','/api/capture/room-overview/daily']);
 assert.deepEqual(report.summary,{LIVE:1,OFFLINE:0,UNKNOWN:0});
 assert.equal(report.shopJoinCount,1);
 assert.equal(report.exhaustive,false);
 assert.equal(report.formalOpeningRatePercent,null);
 assert.equal(report.formalFullDurationRatePercent,null);
 assert.equal(report.publicIdentityLinkedToOpsRooms,false);
 const s=JSON.stringify(report);
 assert.doesNotMatch(s,/NEVER_SERIALIZE|NOT_ALLOWED_TO_SERIALIZE|last_heartbeat_at|bound_session_key/);
});
test('failed source cannot silently convert to 0 rooms / OFFLINE / fake full census',async()=>{
 const r=await scanDouyinOps({reader:async()=>{throw Error('403_ACCESS_RESTRICTED')},config:cfg,at:NOW});
 assert.equal(r.sourceAccess,'UNVERIFIED');
 assert.equal(r.catalogComplete,false);
 assert.deepEqual(r.summary,{LIVE:0,OFFLINE:0,UNKNOWN:0});
 assert.ok(r.warnings.includes('ROOMS_UNAVAILABLE_OR_INVALID'));
});
test('no Douyin room in a valid mixed catalog is NOT evidence of OFFLINE',async()=>{
 const r=await scanDouyinOps({reader:async path=>{
  if(path==='/api/capture/rooms')return roomInput([{platform:'jd',id:17}],1);
  if(path==='/api/shops')return [];
  if(path==='/api/assistant/active-rooms')return {rooms:[]};
 },config:cfg,at:NOW});
 assert.ok(r.warnings.includes('NO_DOUYIN_ROOMS_IN_RESPONSE_NOT_OFFLINE'));
 assert.equal(r.rooms.length,0);
 assert.equal(r.exhaustive,false);
});
test('Do not create fake down-time on a session counter change',()=>{
 const a=summarizeDouyinGap({date:DATE,at:NOW-600000,state:'LIVE',sessionCount:1},
    {date:DATE,at:NOW,state:'LIVE',sessionCount:2});
 assert.equal(a.event,'SESSION_BREAK_BETWEEN_POLLS');
 assert.equal(a.calibratedOffline,false);
 assert.equal(a.exactDownTime,null);
});
