import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const w=fs.readFileSync(new URL('../.github/workflows/jd-r23-scheduled.yml',import.meta.url),'utf8');
const block=w.match(/- name: Check if today's 90-day history checkpoint already exists[\s\S]*?(?=\n\s{6}- name:)/)?.[0]||'';
test('daily archive admission requires SOURCE+ACCEPTED+STATE all successful',()=>{
 assert.match(block,/if: steps\.window\.outputs\.should_run == 'true' && steps\.state\.outcome == 'success' && steps\.source\.outcome == 'success' && steps\.accepted\.outcome == 'success' && github\.ref == 'refs\/heads\/main'/);
});
test('failed source can still create UNKNOWN state but must not lock daily archive',()=>{
 assert.match(w,/id: source[\s\S]{0,250}continue-on-error: true/);
 assert.match(w,/id: accepted[\s\S]{0,250}continue-on-error: true/);
 assert.match(w,/name: Carry state forward; mark failed\/unknown signals UNKNOWN/);
 assert.match(block,/steps\.source\.outcome == 'success'/);
 assert.match(block,/steps\.accepted\.outcome == 'success'/);
});
test('rolling state remains 7 days, daily checkpoint remains 90 days',()=>{
 const rolling=w.match(/- name: Upload rolling history and sanitized snapshot[\s\S]*?(?=\n\s{6}- name:)/)?.[0]||'';
 const daily=w.match(/- name: Upload one daily 90-day immutable checkpoint[\s\S]*?(?=\n\s{6}- name:)/)?.[0]||'';
 assert.match(rolling,/retention-days: 7/);
 assert.doesNotMatch(rolling,/retention-days: 90/);
 assert.match(daily,/retention-days: 90/);
});
test('no Pages, permissions escalation or fabricated OFFLINE',()=>{
 assert.match(w,/permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
 assert.doesNotMatch(w,/contents:\s*write|deploy-pages|upload-pages-artifact/);
 assert.match(w,/formal opening rate remains NULL/);
 assert.match(w,/mark failed\/unknown signals UNKNOWN/);
});
