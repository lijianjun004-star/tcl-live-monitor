// Guards on the monitoring scope config: only identity-verified IDs, and new scope never scores by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('../config/probe-targets.json', import.meta.url)));

test('tmall targets: numeric IDs, unique, only the user-confirmed shop is scoring-eligible', () => {
  const ids = cfg.tmall.map(t => t.accountId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate tmall accountId');
  for (const t of cfg.tmall) {
    assert.match(String(t.accountId), /^\d{5,16}$/, t.key);
    assert.ok(t.displayName, t.key);
    assert.ok(t.userConfirmed === true || t.scopeApproved === true, t.key);
    if (t.userConfirmed !== true) assert.equal(t.scoringEligible, false, `${t.key} must not score`);
  }
});

test('tmall targets exclude IDs refuted by reverse identity check (run 42052553183)', () => {
  const refuted = ['1796933267', '2616970884', '2213856588863', '2200805864660']; // 影音数码配件行家 / 苏宁官旗 / 天猫数码家电自营 / 星彦旗舰店
  for (const id of refuted) assert.ok(!cfg.tmall.some(t => t.accountId === id), id);
});

test('douyin targets: unique 抖音号 and secUid; added scope never scores by default', () => {
  const ids = cfg.douyin.map(t => t.displayDouyinId), urls = cfg.douyin.map(t => t.profileUrl);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(urls).size, urls.length);
  for (const t of cfg.douyin) if (!/11-03/.test(t.scopeSource || '')) assert.equal(t.scoringEligible, false, t.key);
});
