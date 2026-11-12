import test from 'node:test';import assert from 'node:assert/strict';
import {preflightHourlyPilot as gate} from '../../probes/r315/hourly-pilot-gate.mjs';
const d='2026-11-12';
const at=m=>d+'T09:'+String(m).padStart(2,'0')+':00.000Z';
const base={platform:'jd',trigger:'schedule',now:at(17),lockHeld:true,sourceApproved:true};
const receipt=(time=at(0))=>({platform:'jd',observedAt:time,verifiedArtifact:true,
  sourceReadOk:true,schemaValidated:true,artifactSha256:'a'.repeat(64)});
test('schedule is only a candidate under independently held lock and approved source',()=>{
 assert.equal(gate(base).decision,'ALLOW_CANDIDATE');
 assert.equal(gate({...base,lockHeld:false}).reason,'EXCLUSIVE_PLATFORM_LOCK_REQUIRED');
 assert.equal(gate({...base,sourceApproved:false}).reason,'SOURCE_AUTHORIZATION_NOT_VERIFIED');
 assert.equal(gate({...base,platform:'tianmao'}).decision,'BLOCK');
});
test('manual and delayed runs can never pretend to be real schedule evidence',()=>{
 assert.equal(gate({...base,trigger:'workflow_dispatch'}).decision,'DIAGNOSTIC_ONLY');
 for(const m of [0,14,16,30,46,59]){
  assert.equal(gate({...base,now:at(m)}).decision,'SKIP',String(m));
 }
});
test('JD backup only within approved window after stale independently verified prior',()=>{
 assert.equal(gate({...base,now:at(47),priorReceipt:receipt(at(0)),trustedPrior:true}).decision,'SKIP');
 // Previous valid 08:47 observation -> 60 minutes have elapsed by 09:47.
 const previous={...receipt('2026-11-12T08:47:00.000Z')};
 const x=gate({...base,now:at(47),priorReceipt:previous,trustedPrior:true});
 assert.equal(x.decision,'ALLOW_CANDIDATE');
 assert.equal(x.slot,'backup');
});
test('untrusted prior, malformed hash and wrong platform never allow backup',()=>{
 for(const bad of [
  {receipt:receipt(),trustedPrior:false},
  {receipt:{...receipt(),artifactSha256:'short'},trustedPrior:true},
  {receipt:{...receipt(),platform:'douyin'},trustedPrior:true},
  {receipt:{...receipt(),observedAt:'invalid'},trustedPrior:true},
 ]){
 const x=gate({...base,now:at(47),priorReceipt:bad.receipt,trustedPrior:bad.trustedPrior});
 assert.equal(x.decision,'BLOCK');
 }
});
test('Douyin primary :23 and backup :53 are distinct from JD',()=>{
 const dy={...base,platform:'douyin',now:at(23)};
 assert.equal(gate(dy).decision,'ALLOW_CANDIDATE');
 assert.equal(gate({...dy,now:at(17)}).decision,'SKIP');
 assert.equal(gate({...dy,now:at(53)}).slot,'backup');
});
test('no candidate can claim hourly guarantee, production status or KPI',()=>{
 const x=gate(base);
 assert.equal(x.guaranteedHourly,false);
 assert.equal(x.formalRate,null);
 assert.ok(!('LIVE' in x)&&!('OFFLINE' in x));
});
