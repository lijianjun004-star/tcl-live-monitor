// R3.23: run the probe's private diagnostics function in Chromium on synthetic HTML (no network at all).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const run = process.env.R320_BROWSER_SMOKE === '1';
test('Chromium: private diagnostics return ancestry labels only, letters only, no text', { skip: !run }, async () => {
  const { chromium } = await import('playwright');
  const src = fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs', 'utf8');
  const fn = /const raw = await page\.evaluate\((\(\) => \{[\s\S]*?\n    \})\)\.catch\(\(\) => null\);/.exec(src)?.[1];
  assert.ok(fn, 'diagnostics function present');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext(); await ctx.route('**/*', r => r.abort('blockedbyclient'));
    const page = await ctx.newPage();
    await page.setContent('<main data-e2e="page-123"><div data-e2e="user-info">抖音号：SYNTHETIC</div>' +
      '<section data-e2e="live-entry-7788"><a href="https://live.douyin.com/20000000002">直播中 SECRET_TEXT</a></section>' +
      '<aside><a href="https://live.douyin.com/30000000003">推荐</a><a href="https://www.douyin.com/user/SYNTHETIC_SEC_UID_0001?x=1">主页</a></aside></main>');
    const raw = await page.evaluate('(' + fn + ')()');
    assert.deepEqual(raw.live.map(x => [x.room, x.liveText]), [['20000000002', true], ['30000000003', false]]);
    assert.deepEqual(raw.live[0].ancestry.slice(0, 3), ['section[live-entry-]', 'main[page-]', 'body']);
    assert.deepEqual(raw.users.map(x => x.path), ['/user/SYNTHETIC_SEC_UID_0001']);
    const all = JSON.stringify(raw.live.map(x => x.ancestry).concat(raw.users.map(x => x.ancestry)));
    assert.doesNotMatch(all, /SECRET_TEXT|SYNTHETIC|\d/);
    await ctx.close();
  } finally { await browser.close(); }
});
