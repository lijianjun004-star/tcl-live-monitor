import test from 'node:test';
import assert from 'node:assert/strict';
import { planApprovedDouyinBatches } from '../../probes/r315/rpa-batching.mjs';

const target = (key, scopeApproved = true) => ({ key, scopeApproved,
  profileUrl:`https://www.douyin.com/user/MS4wLjABAAAA${key.padEnd(24, '0')}` });
test('plans deterministic pairs and only approved entries', () => {
  const entries = [target('c'), target('a'), target('d', false), target('b')];
  const expected = [['a', 'b'], ['c']];
  assert.deepEqual(planApprovedDouyinBatches({ douyin: entries }), expected);
  assert.deepEqual(planApprovedDouyinBatches({ douyin: [...entries].reverse() }), expected);
});
test('makes six batches for twelve approved entries', () => {
  const entries = Array.from({ length: 12 }, (_, i) => target(`target-${String(i).padStart(2, '0')}`));
  const batches = planApprovedDouyinBatches({ douyin: entries });
  assert.equal(batches.length, 6);
  assert.ok(batches.every(batch => batch.length === 2));
  assert.equal(new Set(batches.flat()).size, 12);
});
test('rejects unknown, ambiguous and unapproved-only configuration', () => {
  const invalid = [null, {}, { douyin: {} }, { douyin: [] },
    { douyin: [target('a', false)] }, { douyin: [{ key: 'a' }] },
    { douyin: [target('a', 'true')] }, { douyin: [target('a'), target('a', false)] },
    { douyin: [target('')] }, { douyin: [null] }];
  for (const config of invalid) assert.throws(() => planApprovedDouyinBatches(config), /RPA_BATCH_/);
});
test('rejects duplicate or noncanonical approved profile URLs', () => {
  const a=target('a'), b=target('b');
  assert.throws(() => planApprovedDouyinBatches({douyin:[a,{...b,profileUrl:a.profileUrl}]}),
    /RPA_BATCH_INVALID_OR_DUPLICATE_PROFILE/);
  for (const profileUrl of [undefined, null, a.profileUrl+'?x=1', a.profileUrl+'#x',
    a.profileUrl+'/', a.profileUrl.replace('https:', 'http:'),
    a.profileUrl.replace('www.douyin.com','other.invalid'), a.profileUrl.replace('www.','WWW.')]) {
    assert.throws(() => planApprovedDouyinBatches({douyin:[{...a,profileUrl}]}),
      /RPA_BATCH_INVALID_OR_DUPLICATE_PROFILE/);
  }
});
