import test from 'node:test';
import assert from 'node:assert/strict';
import { scanAggregate as scan } from '../../probes/r315/source-aggregate.mjs';
const scanAggregate = args => scan({baselineRoomIds:['11'], ...args});
const date = '2026-11-12';
const mock = (value, calls, failAt) => async (path, params) => {
  calls.push({path, params});
  if (path === failAt) throw new Error('sensitive raw exception');
  if (path.endsWith('/capture/rooms')) return {rooms: [
    {id:'11', shop_id:'31', platform:value, bound_session_key:'private'},
    {id:'12', shop_id:'32', platform:'OTHER'},
  ]};
  if (path.endsWith('/shops')) return [{id:'31',platform:value}];
  if (path.endsWith('/active-rooms')) return {rooms:[{id:'11',platform:value}]};
  return {days:[{date}]};
};
for (const platformValue of ['jd', 'dy']) test(`aggregate preserves source platform (${platformValue}) and suppresses IDs`, async () => {
  const calls = [], report = await scanAggregate({reader:mock(platformValue,calls),platformValue,knownPlatformValues:[platformValue,'OTHER'],date,minimumObservedRooms:1});
  assert.deepEqual([report.roomCount,report.shopCount,report.roomShopJoins,report.heartbeatRowsMatched,report.dailyDateRows], [1,1,1,1,1]);
  assert.equal(report.captureBoundCount,undefined);
  assert.equal(report.UNKNOWN,1); assert.equal(report.LIVE,0); assert.equal(report.OFFLINE,0);
  assert.equal(report.catalogComplete,false); assert.equal(calls[3].params.platform,platformValue);
  assert.equal(JSON.stringify(report).includes('private'),false); assert.equal(JSON.stringify(report).includes('11'),false);
});
test('platform value comparison is exact, no inferred alias', async () => {
  const calls = [], report = await scanAggregate({reader:mock('JD',calls),platformValue:'jd',knownPlatformValues:['jd','JD','OTHER'],date,minimumObservedRooms:1});
  assert.equal(report.sourceAccess,'UNKNOWN'); assert.equal(report.roomCount,undefined); assert.equal(calls.length,1);
});
test('any reader failure stops subsequent calls and discards sensitive exceptions', async () => {
  const calls = [], report = await scanAggregate({reader:mock('jd',calls,'/api/shops'),platformValue:'jd',knownPlatformValues:['jd','OTHER'],date,minimumObservedRooms:1});
  assert.equal(calls.length,2); assert.equal(report.sourceAccess,'UNKNOWN');
  assert.equal(JSON.stringify(report).includes('sensitive'),false);
});
test('malformed source is never converted into a successful empty catalog', async () => {
  const calls = [], report = await scanAggregate({reader:async path => {calls.push(path); return {};},platformValue:'jd',knownPlatformValues:['jd','OTHER'],date,minimumObservedRooms:1});
  assert.equal(report.sourceAccess,'UNKNOWN'); assert.equal(calls.length,1);
});
test('invalid date, platform or bound stops before calling reader', async () => {
  for (const args of [{date:'2026-02-30'}, {platformValue:''}, {maxRooms:101}]) {
    const calls=[], report=await scanAggregate({reader:mock('jd',calls),platformValue:'jd',knownPlatformValues:['jd','OTHER'],date,minimumObservedRooms:1,...args});
    assert.equal(report.reason,'INVALID_INPUT'); assert.equal(calls.length,0);
  }
});
test('a decline below the supplied historical minimum stops after the rooms request', async () => {
  const calls=[], report=await scanAggregate({reader:mock('jd',calls),platformValue:'jd',knownPlatformValues:['jd','OTHER'],date,minimumObservedRooms:2,baselineRoomIds:['11','13']});
  assert.equal(report.sourceAccess,'UNKNOWN'); assert.equal(calls.length,1);
});

test('unsafe numeric room, shop and heartbeat IDs stop without queries using rounded values', async () => {
  for (const stage of ['rooms','roomShop','shops','heartbeat']) {
    const calls = [], unsafe = 9007199254740992;
    const reader = async path => {
      calls.push(path);
      if (path.endsWith('/capture/rooms')) return {rooms:[{id:stage==='rooms'?unsafe:'11',shop_id:stage==='roomShop'?unsafe:'31',platform:'jd'}]};
      if (path.endsWith('/shops')) return [{id:stage==='shops'?unsafe:'31',platform:'jd'}];
      if (path.endsWith('/active-rooms')) return {rooms:[{id:stage==='heartbeat'?unsafe:'11',platform:'jd'}]};
      throw Error('should not reach daily');
    };
    const out = await scanAggregate({reader,platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1});
    assert.equal(out.sourceAccess,'UNKNOWN',stage);
    assert.equal(calls.some(x=>x.endsWith('/daily')),false,stage);
  }
});

test('large string identifiers remain exact when sent to daily', async () => {
  const rid='9007199254740993', calls=[];
  const reader=async (path,params) => {
    calls.push({path,params});
    if(path.endsWith('/capture/rooms')) return {rooms:[{id:rid,platform:'jd'}]};
    if(path.endsWith('/shops')) return [];
    if(path.endsWith('/active-rooms')) return {rooms:[]};
    return {days:[{date}]};
  };
  const out=await scanAggregate({reader,platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1,baselineRoomIds:[rid]});
  assert.equal(out.sourceAccess,'PARTIAL');
  assert.equal(calls[3].params.live_room_id,rid);
  assert.equal(JSON.stringify(out).includes(rid),false);
});

test('malformed or unknown platform values abort rather than silently discard rows', async () => {
  for (const platform of [undefined,null,{},'unreviewed']) {
    const calls=[];
    const reader=async path=>{calls.push(path); return {rooms:[{id:'11',platform:'jd'},{id:'12',platform}]};};
    const out=await scanAggregate({reader,platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1});
    assert.equal(out.sourceAccess,'UNKNOWN'); assert.equal(calls.length,1);
  }
});

test('null, invalid or duplicate daily entries fail closed', async () => {
  for (const days of [[null],[{}],[{date:'2026-02-30'}],[{date},{date}]]) {
    const calls=[];
    const reader=async(path,params)=>path.endsWith('/daily')?{days}:mock('jd',calls)(path,params);
    const out=await scanAggregate({reader,platformValue:'jd',knownPlatformValues:['jd','OTHER'],date,minimumObservedRooms:1});
    assert.equal(out.sourceAccess,'UNKNOWN');
  }
});

test('equal counts cannot hide a missing or replaced baseline room', async () => {
  for (const baselineRoomIds of [['11','12'], ['12'], ['11','13'], []]) {
    const calls=[];
    const report=await scanAggregate({reader:mock('jd',calls),platformValue:'jd',knownPlatformValues:['jd','OTHER'],date,minimumObservedRooms:1,baselineRoomIds});
    assert.equal(report.sourceAccess,'UNKNOWN');
    assert.ok(calls.length <= 1, 'no shop, heartbeat or daily request after mismatch');
  }
});

test('baseline must be an independently provided exact, unique string set', async () => {
  for (const baselineRoomIds of [undefined, null, [11], ['11','11'], ['bad'], ['1'.repeat(17)]]) {
    const calls=[];
    const report=await scanAggregate({reader:mock('jd',calls),platformValue:'jd',knownPlatformValues:['jd','OTHER'],date,minimumObservedRooms:1,baselineRoomIds});
    assert.equal(report.reason,'INVALID_INPUT');
    assert.equal(calls.length,0);
  }
});

test('reviewed baseline and platform vocabulary cannot be widened during source reads', async () => {
  for (const changed of ['baseline','platforms']) {
    const baselineRoomIds=['11'], knownPlatformValues=['jd'];
    let calls=0;
    const reader=async () => {
      calls++;
      if (changed === 'baseline') {
        baselineRoomIds[0]='12';
        return {rooms:[{id:'12',platform:'jd'}]};
      }
      knownPlatformValues.push('unexpected');
      return {rooms:[{id:'11',platform:'jd'},{id:'13',platform:'unexpected'}]};
    };
    const report=await scanAggregate({reader,platformValue:'jd',knownPlatformValues,date,minimumObservedRooms:1,baselineRoomIds});
    assert.equal(report.sourceAccess,'UNKNOWN',changed);
    assert.equal(calls,1);
  }
});

test('conflicting or invalid alias fields in rooms, shops, heartbeats or associations stop the scan', async () => {
  for (const kind of ['room','shop','heartbeat','association']) {
    for (const invalid of [false,true]) {
      const room={id:'11',shop_id:'31',platform:'jd'};
      const shop={id:'31',platform:'jd'};
      const heartbeat={id:'11',platform:'jd'};
      if (kind==='room') room.room_id=invalid?{}:'12';
      if (kind==='shop') shop.shop_id=invalid?{}:'32';
      if (kind==='heartbeat') heartbeat.live_room_id=invalid?{}:'12';
      if (kind==='association') room.shopId=invalid?{}:'32';
      const calls=[];
      const reader=async path=>{
        calls.push(path);
        if(path.endsWith('/capture/rooms')) return {rooms:[room]};
        if(path.endsWith('/shops')) return [shop];
        if(path.endsWith('/active-rooms')) return {rooms:[heartbeat]};
        throw Error('daily must not run');
      };
      const out=await scanAggregate({reader,platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1});
      assert.equal(out.sourceAccess,'UNKNOWN',kind);
      assert.equal(calls.some(x=>x.endsWith('/daily')),false,kind);
      assert.deepEqual(Object.keys(out).sort(),['catalogComplete','reason','sourceAccess']);
    }
  }
});

test('matching exact ID aliases do not block synthetic source collection', async () => {
  const reader=async path=>{
    if(path.endsWith('/capture/rooms')) return {rooms:[{id:'11',room_id:11,shop_id:'31',shopId:31,shop:{id:'31'},platform:'jd'}]};
    if(path.endsWith('/shops')) return [{id:'31',shop_id:31,platform:'jd'}];
    if(path.endsWith('/active-rooms')) return {rooms:[{id:11,live_room_id:'11',platform:'jd'}]};
    return {days:[{date}]};
  };
  const out=await scanAggregate({reader,platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1});
  assert.equal(out.sourceAccess,'PARTIAL');
  assert.equal(out.roomShopJoins,1);
  assert.equal(out.heartbeatRowsMatched,1);
});


test('P1 pagination evidence blocks every stage before publication',async()=>{
 for(const stage of ['rooms','shops','heartbeat','daily']){
  let calls=0;
  const result=await scanAggregate({platformValue:'jd',knownPlatformValues:['jd'],
    date,minimumObservedRooms:1,
    reader:async path=>{
      calls++;
      if(path.endsWith('/capture/rooms'))return {rooms:[{id:'11',shop_id:'31',platform:'jd'}],
        ...(stage==='rooms'?{total:2,has_more:true,next_cursor:'page2'}:{})};
      if(path.endsWith('/shops'))return {shops:[{id:'31',platform:'jd'}],
        ...(stage==='shops'?{data:{pagination:{hasMore:true}}}:{})};
      if(path.endsWith('/active-rooms'))return {rooms:[{id:'11',platform:'jd'}],
        ...(stage==='heartbeat'?{pagination:{nextCursor:'NEXT'}}:{})};
      return {days:[{date}],...(stage==='daily'?{total_count:200,hasMore:true}:{})};
    }});
  assert.equal(result.sourceAccess,'UNKNOWN',stage);
  assert.equal(result.catalogComplete,false,stage);
  assert.ok(calls<=4,stage);
 }
});
test('P1 contradictory room containers and total count mismatch abort first read',async()=>{
 for(const doc of [
  {rooms:[{id:'11',platform:'jd'}],data:{rooms:[{id:'99',platform:'jd'}]}},
  {rooms:[{id:'11',platform:'jd'}],pagination:{total:500}},
  {rooms:[{id:'11',platform:'jd'}],data:{pagination:{offset:1}}},
  {rooms:[{id:'11',platform:'jd'}],has_more:true}
 ]){
  let count=0;
  const x=await scanAggregate({platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1,
     reader:async()=>{count++;return doc}});
  assert.equal(x.sourceAccess,'UNKNOWN');
  assert.equal(count,1);
 }
});
test('P2 global ID collision between JD and Douyin stops before other endpoints',async()=>{
 for(const stage of ['rooms','shops','heartbeat']){
  let calls=0;
  const reader=async path=>{
   calls++;
   if(path.endsWith('/capture/rooms'))return {rooms:stage==='rooms'?
     [{id:'11',platform:'jd'},{id:'11',platform:'dy'}]:[{id:'11',platform:'jd'}]};
   if(path.endsWith('/shops'))return stage==='shops'?
     [{id:'31',platform:'jd'},{id:'31',platform:'dy'}]:[];
   if(path.endsWith('/active-rooms'))return {rooms:stage==='heartbeat'?
     [{id:'11',platform:'jd'},{id:'11',platform:'dy'}]:[]};
   return {days:[{date}]};
  };
  const x=await scanAggregate({reader,platformValue:'jd',knownPlatformValues:['jd','dy'],
     date,minimumObservedRooms:1});
  assert.equal(x.sourceAccess,'UNKNOWN',stage);
  assert.ok(calls<4,stage);
 }
});
test('P2 consistent-null shop aliases accepted, malformed nested shop rejected',async()=>{
 const makeReader=room=>async path=>{
  if(path.endsWith('/capture/rooms'))return {rooms:[room]};
  if(path.endsWith('/shops'))return [];
  if(path.endsWith('/active-rooms'))return {rooms:[]};
  return {days:[{date}]};
 };
 const common={id:'11',platform:'jd'};
 const ok=await scanAggregate({reader:makeReader({...common,shop_id:null,shopId:null}),
   platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1});
 assert.equal(ok.sourceAccess,'PARTIAL');
 const bad=await scanAggregate({reader:makeReader({...common,shop:{unexpected:'x'}}),
   platformValue:'jd',knownPlatformValues:['jd'],date,minimumObservedRooms:1});
 assert.equal(bad.sourceAccess,'UNKNOWN');
});
