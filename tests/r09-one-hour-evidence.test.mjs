import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const doc=JSON.parse(fs.readFileSync(new URL('../fixtures/one-hour-actions-safe-aggregate-20261105.json',import.meta.url)));

test('historical one-hour JD event count is internally consistent and shows no confirmed OFFLINE/new session',()=>{
 const jd=doc.jd;
 assert.equal(jd.rounds,12);assert.equal(jd.sourceRooms,6);assert.equal(jd.totalObservations,72);
 assert.equal(jd.LIVE+jd.OFFLINE+jd.UNKNOWN,72);
 assert.equal(Object.values(jd.byOpsRoomId).reduce((n,x)=>n+x.LIVE+x.OFFLINE+x.UNKNOWN,0),72);
 assert.ok(Object.values(jd.byOpsRoomId).every(x=>x.observedSessionCounts.every(s=>s===1)));
 assert.equal(jd.confirmedNewSessionEvents,0);
 assert.equal(jd.OFFLINE,0);
 assert.equal(jd.byOpsRoomId['16'].UNKNOWN,12);
 assert.equal(jd.byOpsRoomId['16'].offlineCandidateNotValidated,true);
});

test('historical public 1-hour summary has 12x12 Douyin and 1x12 Tmall, no confirmed OFFLINE',()=>{
 const p=doc.public;const d=p.byDouyinConfigKey;
 assert.equal(Object.keys(d).length,12);
 assert.equal(Object.values(d).reduce((n,x)=>n+x.LIVE,0),60);
 assert.equal(Object.values(d).reduce((n,x)=>n+x.UNKNOWN,0),84);
 assert.equal(p.douyinTotals.LIVE+p.douyinTotals.UNKNOWN+p.douyinTotals.OFFLINE,144);
 assert.equal(p.tmallApiError,12);assert.equal(p.tmallTotals.UNKNOWN,12);
 assert.equal(p.douyinTotals.OFFLINE,0);assert.equal(p.tmallTotals.OFFLINE,0);
 assert.equal(doc.notRealtime,true);
});
