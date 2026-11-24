import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadonlyReader } from '../../probes/r315/readonly-reader.mjs';
import { scanAggregate } from '../../probes/r315/source-aggregate.mjs';

// Synthetic HTTPS source: no network and no real source schema assertions.
const origin = 'https://example.invalid', date = '2026-11-12';
const paths = ['/api/capture/rooms', '/api/shops', '/api/assistant/active-rooms', '/api/capture/room-overview/daily'];
const requestConfig = {origin, approvedOrigins:[origin], approvedPlatforms:['jd'], approvedDates:[date],
  approvedRoomIdsByPlatform:{jd:['11']}, validators:Object.fromEntries(paths.map(p => [p, () => true]))};
const options = {platformValue:'jd', knownPlatformValues:['jd'], date, baselineRoomIds:['11'], minimumObservedRooms:1};
function setup({roomId='11', challenge=false} = {}) {
  const seen=[];
  const fetchImpl = async (raw, init) => {
    const url=new URL(raw);
    seen.push({path:url.pathname, init});
    assert.equal(init.method,'GET');
    assert.equal(init.credentials,'omit');
    assert.equal(init.redirect,'error');
    if (challenge && url.pathname === paths[1]) return new Response('captcha', {status:403});
    const body=url.pathname===paths[0] ? {rooms:[{id:roomId,shop_id:'31',platform:'jd'}]} :
      url.pathname===paths[1] ? [{id:'31',platform:'jd'}] :
      url.pathname===paths[2] ? {rooms:[{id:'11',platform:'jd'}]} : {days:[{date}]};
    return new Response(JSON.stringify(body), {headers:{'content-type':'application/json'}});
  };
  return {seen, reader:createReadonlyReader({...requestConfig,fetchImpl})};
}
test('synthetic approved catalog traverses reader and returns aggregate only', async () => {
  const {seen,reader}=setup();
  const result=await scanAggregate({...options,reader:reader.read});
  assert.deepEqual(seen.map(x=>x.path),paths);
  assert.equal(result.sourceAccess,'PARTIAL');
  assert.equal(result.catalogComplete,false);
  assert.equal(result.UNKNOWN,1);
  assert.equal(JSON.stringify(result).includes('31'),false);
});
test('synthetic replacement or access challenge stops before daily collection', async () => {
  for (const input of [{roomId:'12'}, {challenge:true}]) {
    const {seen,reader}=setup(input);
    const result=await scanAggregate({...options,reader:reader.read});
    assert.equal(result.sourceAccess,'UNKNOWN');
    assert.equal(seen.some(x=>x.path===paths[3]),false);
  }
});
