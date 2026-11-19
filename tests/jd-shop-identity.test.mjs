import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readJdShopPage, checkJdShops } from '../probes/lib/jd-shop-identity.mjs';

const target = { id: '721631', claimedName: 'TCL官方旗舰店' };
const storeUrl = 'https://shop.m.jd.com/?shopId=721631';
const anchor = (href, visible = true) => ({
  href,
  checkVisibility: () => visible,
  getClientRects: () => visible ? [{ width: 40 }] : [],
});

function render({ url = storeUrl, title = 'TCL官方旗舰店 - 京东', text = '', anchors = [] } = {}) {
  const document = { title, body: { innerText: text }, querySelectorAll: () => anchors };
  const output = vm.runInNewContext('(' + readJdShopPage.toString() + ')(target)', {
    URL, location: { href: url }, document, target,
  });
  return JSON.parse(JSON.stringify(output));
}

test('known login host, login title, and visible challenge stop the shop check', () => {
  for (const page of [
    { url: 'https://plogin.m.jd.com/login/login', title: '' },
    { title: '京东登录注册' },
    { text: '请按照图中轨迹绘制' },
  ]) {
    assert.deepEqual(render(page), { result: 'WALLED' });
  }
});

test('only visible links on the matching store are recorded as candidate IDs', () => {
  const link = 'https://lives.jd.com/?track=private#/49620441?sharer=private';
  const anchors = [
    anchor(link), anchor(link), anchor('https://lives.jd.com/#/49620442', false),
    anchor('https://lives.jd.com.example.org/#/49620443'), anchor('https://lives.jd.com/#/49620444more'),
  ];
  const result = render({ anchors });
  assert.deepEqual(result.candidateSessionIds, ['49620441']);
  assert.doesNotMatch(JSON.stringify(result), /private|track|sharer|LIVE|OFFLINE/);
  assert.deepEqual(render({ anchors, title: '其他旗舰店' }).candidateSessionIds, []);
  for (const url of [
    'https://mall.jd.com/index-999999.html',
    'https://shop.m.jd.com/?shopId=721631&shopId=999999',
    'https://shop.m.jd.com.example.org/?shopId=721631',
  ]) {
    assert.deepEqual(render({ anchors, url }), { result: 'UNEXPECTED_DESTINATION' });
  }
});

test('a wall stops both JD channels and all remaining JD stores', async () => {
  for (const response of [{ result: 'WALLED', http: 200 }, { result: 'PAGE_READ', http: 429 }]) {
    const rows = [];
    const calls = [];
    const blocked = await checkJdShops([target, { id: '123456', claimedName: '第二家店' }], async (_channel, url) => {
      calls.push(url);
      return response;
    }, row => rows.push(row));
    assert.equal(blocked, true);
    assert.deepEqual(calls, ['https://mall.jd.com/index-721631.html']);
    assert.deepEqual(rows.map(row => row.result), ['WALLED', ...Array(3).fill('SKIPPED_PLATFORM_WALLED')]);
  }
});

test('error pages cannot supply candidate session IDs', async () => {
  const rows = [];
  await checkJdShops([target], async () => ({ http: 500, ...render({
    anchors: [anchor('https://lives.jd.com/#/49620441')],
  }) }), row => rows.push(row));
  for (const row of rows) {
    assert.equal(row.result, 'NAV_ERROR');
    assert.equal(row.candidateSessionIds, undefined);
  }
});

test('the user-supplied historical sample is separate from the verified store', async () => {
  const registry = JSON.parse(await readFile(new URL('../config/identity-check-targets.json', import.meta.url)));
  const store = registry.jdShopIds.find(row => row.id === target.id);
  assert.equal(store.claimedName, target.claimedName);
  assert.equal(JSON.stringify(store).includes('49620440'), false);
  assert.ok(registry.jdSharedSessionIds.includes('49620440'));
});
