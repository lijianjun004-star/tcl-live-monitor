// R0.7 regressions built from the REAL ops-platform response layouts observed 2026-11-04/05
// (field names and nesting as returned; all values synthetic, no business data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShopList, scanJdSource } from '../probes/lib/tcl-jd-all.mjs';
import { trackSessionGap } from '../probes/lib/tcl-ops.mjs';
import { profileIdentity } from '../probes/lib/douyin.mjs';

const AT = Date.parse('2026-11-05T12:00:20Z'); // 20:00:20 Beijing
const DATE = '2026-11-05';
// /api/shops is a BARE ARRAY in production (not {shops:[...]}) and carries anchor_name.
const shopsBody = [
  { id: 1, name: 'S1', platform: 'jd', category: '冰箱', anchor_name: 'A', created_at: '2026-10-01T00:00:00Z' },
  { id: 14, name: 'S14', platform: 'jd', category: '洗衣机', anchor_name: 'B', created_at: '2026-10-01T00:00:00Z' },
  { id: 3, name: 'D3', platform: 'douyin', category: '电视', anchor_name: 'C', created_at: '2026-10-01T00:00:00Z' },
];
const roomsBody = { ok: true, rooms: [
  { id: 1, name: 'R1', platform: 'jd', category: '冰箱', shop_id: 1, shop_name: 'S1', note: '', bound_session_key: 'cap-x', bound_at: '2026-11-04T00:00:00Z', created_at: '2026-10-01T00:00:00Z' },
  { id: 14, name: 'R14', platform: 'jd', category: '洗衣机', shop_id: 14, shop_name: 'S14', note: '', bound_session_key: 'cap-y', bound_at: '2026-11-04T00:00:00Z', created_at: '2026-10-01T00:00:00Z' },
  { id: 3, name: 'D3', platform: 'douyin', category: '电视', shop_id: 3, shop_name: 'D3', note: '', bound_session_key: null, bound_at: null, created_at: '2026-10-01T00:00:00Z' },
] };
const hbBody = { ok: true, rooms: [
  { id: 1, name: 'R1', platform: 'jd', last_heartbeat_at: '2026-11-05T12:00:05Z' },
  { id: 14, name: 'R14', platform: 'jd', last_heartbeat_at: '2026-11-05T12:00:01Z' },
] };
const dailyBody = id => ({ ok: true, meta: { start_date: DATE, end_date: DATE, platform: 'jd', live_room_id: id, shop_id: null, anchor_name: null, day_count: 1, session_count: 1, minute_count: 100 },
  days: [{ date: DATE, session_count: 1, minute_count: 100, current_cnt_avg: 1, current_cnt_max: 2, metrics: {},
    latest_minute_ts: id === 14 ? '2026-11-05T11:59:00+00:00' : '2026-11-05T10:54:00+00:00',
    latest: { status: 1, dealAmt: 12345, onlineUv: 9 } }] });
const reader = async (path, params) => {
  if (path === '/api/shops') return shopsBody;
  if (path === '/api/capture/rooms') return roomsBody;
  if (path === '/api/assistant/active-rooms') return hbBody;
  if (path === '/api/capture/room-overview/daily') return dailyBody(Number(params.live_room_id));
  throw new Error('unexpected ' + path);
};

test('R0.7: real /api/shops bare array is parsed; output never carries anchor_name', () => {
  const shops = normalizeShopList(shopsBody);
  assert.deepEqual(shops, [{ shopId: '1' }, { shopId: '14' }]);
  assert.ok(!JSON.stringify(shops).includes('anchor'));
});

test('R0.7: full scan on real shapes has no SHOPS_SCHEMA warning and leaks no business fields', async () => {
  const r = await scanJdSource({ reader, at: AT, date: DATE });
  assert.ok(!r.warnings.includes('SHOPS_SCHEMA_UNVERIFIED'), r.warnings.join(','));
  assert.equal(r.shopCount, 2);
  assert.deepEqual(r.rooms.map(x => [x.roomId, x.status, x.offlineCandidate]), [['1', 'UNKNOWN', true], ['14', 'LIVE', false]]);
  const out = JSON.stringify(r);
  for (const banned of ['anchor', 'dealAmt', 'onlineUv', 'cap-x', 'bound_session_key']) assert.ok(!out.includes(banned), banned);
});

const S = (state, sessionCount, extra = {}) => ({ date: DATE, state, offlineCandidate: false, sessionCount, at: AT, ...extra });
const C = (sessionCount, at = AT) => ({ date: DATE, state: 'UNKNOWN', offlineCandidate: true, sessionCount, at });

test('R0.7: candidate gap that returns as a NEW session = platform-confirmed stop', () => {
  let g = trackSessionGap(null, S('LIVE', 1)); assert.equal(g.event, null);
  g = trackSessionGap(g.next, C(1, AT + 300e3)); assert.equal(g.event, 'GAP_OPENED');
  g = trackSessionGap(g.next, C(1, AT + 600e3)); assert.equal(g.event, null, 'gap stays open, no duplicate event');
  g = trackSessionGap(g.next, S('LIVE', 2)); assert.equal(g.event, 'GAP_CLOSED_NEW_SESSION');
  assert.equal(g.gapOpenedAt, AT + 300e3);
});

test('R0.7: candidate gap inside the SAME session = candidate false positive', () => {
  let g = trackSessionGap(null, S('LIVE', 1));
  g = trackSessionGap(g.next, C(1));
  g = trackSessionGap(g.next, { ...S('UNKNOWN', 1), offlineCandidate: false }); assert.equal(g.event, null, 'plain UNKNOWN keeps gap open');
  g = trackSessionGap(g.next, S('LIVE', 1)); assert.equal(g.event, 'GAP_CLOSED_SAME_SESSION');
});

test('R0.7: session split between two LIVE polls and day rollover', () => {
  assert.equal(trackSessionGap(S('LIVE', 1).date && { ...S('LIVE', 1), gapOpenedAt: null }, S('LIVE', 2)).event, 'SESSION_BREAK_BETWEEN_POLLS');
  assert.equal(trackSessionGap({ ...S('LIVE', 3), date: '2026-11-04', gapOpenedAt: null }, S('LIVE', 1)).event, null, 'counts reset at Beijing midnight');
  assert.equal(trackSessionGap({ ...S('LIVE', 1), gapOpenedAt: AT }, { ...S('LIVE', null) }).event, 'GAP_CLOSED_SESSION_UNKNOWN');
});

test('R0.7: 抖音号 must match exactly, not as a prefix', () => {
  const t = { accountName: 'TCL团购官方号', displayDouyinId: '14145381' };
  const page = id => ({ httpStatus: 200, title: 'TCL团购官方号的抖音 - 抖音', bodyExcerpt: `抖音号：${id} IP属地：广东` });
  assert.equal(profileIdentity(page('14145381'), t), true);
  assert.equal(profileIdentity(page('141453819'), t), false);
  assert.equal(profileIdentity({ ...page('x'), bodyExcerpt: '抖音号:14145381' }, t), true);
  assert.equal(profileIdentity({ ...page('x'), bodyExcerpt: '', douyinIdsInPage: ['141453819'] }, t), false);
});
