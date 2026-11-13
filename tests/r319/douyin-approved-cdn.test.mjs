// R3.19: OFFLINE adversarial resource policy checks. No network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyDouyinResource, CORE_STATIC_CANDIDATES } from '../../probes/r318/douyin-static-policy.mjs';

const policy=(url,resourceType='script',method='GET',opt=false)=>classifyDouyinResource(
  {url,resourceType,method},{approvedCoreStatic:opt});
const wf=()=>fs.readFileSync('.github/workflows/r319-douyin-approved-cdn-once.yml','utf8');
const runner=()=>fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs','utf8');

test('R319: both EXACT approved core CDN hostnames accept only script/stylesheet GET after opt-in',()=>{
  assert.equal(CORE_STATIC_CANDIDATES.length,2);
  for(const h of CORE_STATIC_CANDIDATES){
    for(const typ of ['script','stylesheet']){
      const d=policy('https://'+h+'/file',typ,'GET',true);
      assert.equal(d.allow,true);
      assert.equal(d.reason,'EXPLICITLY_APPROVED_CORE_STATIC');
    }
  }
});
test('R319: default branch behavior denies CDN even for JS/CSS',()=>{
  for(const h of CORE_STATIC_CANDIDATES){
    assert.equal(policy('https://'+h+'/app.js').allow,false);
    assert.equal(policy('https://'+h+'/app.css','stylesheet').allow,false);
  }
});
test('R319: GET/HEAD distinction and no active/script redirects to non-allowlisted hosts',()=>{
  for(const h of CORE_STATIC_CANDIDATES){
    for(const method of ['HEAD','POST','PUT','DELETE']){
      assert.equal(policy('https://'+h+'/file.js','script',method,true).allow,false,method);
    }
    for(const type of ['image','media','xhr','fetch','websocket','eventsource','font','other']){
      assert.equal(policy('https://'+h+'/file.js',type,'GET',true).allow,false,type);
    }
  }
});
test('R319: CDN lookalike / mixed bytegoofy / third-party tracker never allowed',()=>{
  for(const h of [
    'lf-douyin-pc-web.douyinstatic.com.bad.example',
    'attacker-lf-douyin-pc-web.douyinstatic.com',
    'lf3-cdn-tos.bytegoofy.com','lf-webcast-platform.bytetos.com',
    'mon.zijieapi.com','lf-static.applogcdn.com',
    'p3-pc.douyinpic.com'
  ])assert.equal(policy('https://'+h+'/asset.js','script','GET',true).allow,false,h);
});
test('R319: prohibit HTTP credentials and URL parsing edge cases',()=>{
  assert.equal(policy('http://lf-douyin-pc-web.douyinstatic.com/a.js','script','GET',true).allow,false);
  assert.equal(policy('https://user:pass@lf-douyin-pc-web.douyinstatic.com/a.js','script','GET',true).allow,false);
  assert.equal(policy('not-a-url','script','GET',true).allow,false);
});
test('R319: runner requires exact once flag and preserves service-worker and WS denial',()=>{
  const s=runner();
  assert.match(s,/R316_RPA_ONCE !== 'TWO_ACCOUNTS_ONE_PASS'/);
  assert.match(s,/R319_CORE_CDN_APPROVED_ONCE === CDN_FLAG/);
  assert.match(s,/R319_CDN_FLAG_INVALID/);
  assert.match(s,/approvedCoreStatic \}/);
  assert.match(s,/serviceWorkers: 'block'/);
  assert.match(s,/ctx\.routeWebSocket\(/);
  assert.match(s,/const approved = new Map\(/);
  assert.match(s,/scopeApproved === true/);
});
test('R319: 401/403/429 and login redirects stop the entire run',()=>{
  const s=runner();
  assert.match(s,/\[401, 403, 429\]/);
  assert.match(s,/ACCESS_GATE_REDIRECT_RESOURCE/);
  assert.match(s,/for \(const page of ctx\.pages\(\)\) void page\.close/);
  assert.match(s,/if \(stopped\) \{ pub\.push/);
  assert.match(s,/if\(stopped\) process\.exitCode = 3/);
});
test('R319: public receipts are sanitized and do not contain room URLs / account names',()=>{
  const s=runner();
  assert.match(s,/allowedCoreCdn\.set/);
  assert.match(s,/blockedHostsAndTypes/);
  assert.match(s,/formalFullDurationRatePercent:null/);
  const publicSlice=s.slice(s.indexOf('pub.push({ key: t.key, at, profileHttp:'),s.indexOf('priv.push('));
  assert.doesNotMatch(publicSlice,/title:|secUid:|liveRoomIds:|profileUrl:|accountName:/);
});
test('R319: workflow is one-push-only; no cron, dispatch or elevated permissions',()=>{
  const s=wf();
  assert.match(s,/branches: \[experiment\/r319-douyin-core-cdn-approved-once-20261113\]/);
  assert.match(s,/paths: \['\.github\/workflows\/r319-douyin-approved-cdn-once.yml'\]/);
  assert.match(s,/github\.run_attempt == 1/);
  assert.match(s,/\[r319-cdn-rpa-once\]/);
  assert.doesNotMatch(s,/\bschedule:|\bworkflow_dispatch:/);
  assert.match(s,/permissions:\n  contents: read/);
  assert.match(s,/persist-credentials: false/);
});
test('R319: CDN approval is exclusively injected in the guarded single RPA workflow step',()=>{
  const s=wf();
  assert.match(s,/R319_CORE_CDN_APPROVED_ONCE: TWO_APPROVED_CDNS_JS_CSS_ONLY/);
  assert.match(s,/R316_RPA_ONCE: TWO_ACCOUNTS_ONE_PASS/);
  assert.match(s,/node --test tests\/r318\/douyin-static-identity\.test\.mjs tests\/r319\/douyin-approved-cdn\.test\.mjs/);
  assert.match(s,/retention-days: 7/);
  assert.doesNotMatch(s,/secrets\.|GH_TOKEN|pull_request_target/);
});
