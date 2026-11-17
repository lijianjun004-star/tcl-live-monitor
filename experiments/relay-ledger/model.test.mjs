import test from 'node:test';import assert from 'node:assert/strict';
import {bootstrapSimulation,transition,stateHash} from './model.mjs';
const clone=s=>JSON.parse(JSON.stringify(s));
const initial=()=>bootstrapSimulation({now:1000,reviewRef:'synthetic-review'});
const reserve=s=>transition(s,{type:'RESERVE',attemptId:'attempt-1',slotMs:1001,now:1001}).state;
test('missing, damaged state and invalid time remain blocked',()=>{
 for(const s of [null,{}, {...initial(),mode:'invalid'}, {...initial(),lastAt:NaN}])assert.equal(transition(s,{now:1001}).accepted,false);
 assert.equal(transition(initial(),{type:'RESERVE',now:999}).accepted,false);
});
test('reservation survives serialization and duplicate/later rounds cannot resend',()=>{
 const s=clone(reserve(initial()));
 for(const now of [1002,2000,10000000])assert.equal(transition(s,{type:'RESERVE',attemptId:'attempt-2',slotMs:now,now}).accepted,false);
});
test('acceptance is not source success, lost write leaves prior pending record',()=>{
 const reserved=reserve(initial());const r=transition(reserved,{type:'ACCEPTED',attemptId:'attempt-1',now:1002});
 assert.equal(r.state.mode,'PENDING');assert.equal(r.dispatch,false);
 assert.equal(transition(clone(reserved),{type:'RESERVE',attemptId:'attempt-2',slotMs:1003,now:1003}).accepted,false);
});
test('unknown POST outcome blocks and mismatched feedback cannot release it',()=>{
 let s=transition(reserve(initial()),{type:'UNCERTAIN',attemptId:'attempt-1',now:1002}).state;
 assert.equal(s.mode,'REVIEW_REQUIRED');
 for(const attemptId of ['other',null])assert.equal(transition(s,{type:'SOURCE_RESULT',attemptId,now:1003,outcome:'SUCCESS',feedbackReviewed:true,runId:'run-1',evidenceRef:'proof-1'}).accepted,false);
});
test('source failure persists explicit review delay and expiry alone never releases',()=>{
 const pending=reserve(initial());const event={type:'SOURCE_RESULT',attemptId:'attempt-1',now:1003,outcome:'FAILURE',feedbackReviewed:true,runId:'run-1',evidenceRef:'proof-1'};
 assert.equal(transition(pending,event).accepted,false);
 const s=clone(transition(pending,{...event,reviewDelayMs:1000}).state);assert.equal(s.mode,'SOURCE_BACKOFF');assert.equal(s.failures,1);
 assert.equal(transition(s,{type:'RESERVE',attemptId:'attempt-2',slotMs:3000,now:3000}).accepted,false);
 for(const e of [{now:1500,expectedStateHash:stateHash(s)},{now:3000,expectedStateHash:'wrong'}])assert.equal(transition(s,{type:'REVIEW_RELEASE',reviewRef:'review-1',...e}).accepted,false);
 const released=transition(s,{type:'REVIEW_RELEASE',reviewRef:'review-1',expectedStateHash:stateHash(s),now:3000});assert.equal(released.state.mode,'READY');assert.equal(released.dispatch,false);
});
test('reviewed source success still has no real dispatch and old slots cannot replay',()=>{
 const r=transition(reserve(initial()),{type:'SOURCE_RESULT',attemptId:'attempt-1',now:1003,outcome:'SUCCESS',feedbackReviewed:true,runId:'run-1',evidenceRef:'proof-1'});
 assert.equal(r.state.mode,'READY');assert.equal(r.dispatch,false);
 assert.equal(transition(r.state,{type:'RESERVE',attemptId:'new',slotMs:1001,now:1004}).accepted,false);
});
test('audit chain detects accidental mutation and never stores raw errors or secrets',()=>{
 const s=reserve(initial());s.events[0].kind='tampered';assert.equal(transition(s,{now:1005}).accepted,false);
 const r=transition(reserve(initial()),{type:'UNCERTAIN',attemptId:'attempt-1',now:1005,rawError:'PRIVATE_MARKER',token:'PRIVATE_MARKER'});
 assert.ok(!JSON.stringify(r).includes('PRIVATE_MARKER'));assert.notEqual(stateHash(initial()),stateHash(r.state));
});

test('snapshot field corruption cannot clear pending; trace retains safe correlation references',()=>{
 const pending=reserve(initial());assert.equal(transition({...pending,mode:'READY'},{type:'RESERVE',attemptId:'attempt-2',slotMs:1004,now:1004}).accepted,false);
 const r=transition(pending,{type:'SOURCE_RESULT',attemptId:'attempt-1',now:1003,outcome:'SUCCESS',feedbackReviewed:true,runId:'run-1',evidenceRef:'proof-1'});
 assert.equal(r.state.events.at(-1).runId,'run-1');assert.equal(r.state.events.at(-1).evidenceRef,'proof-1');
});
