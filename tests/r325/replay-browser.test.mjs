// R3.25: the probe's private diagnostics locate "直播回放" wording in a rendered page (Chromium, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const run = process.env.R320_BROWSER_SMOKE === '1';
test('Chromium: replay wording is counted with ancestry labels only', { skip: !run }, async () => {
  const { chromium } = await import('playwright');
  const src = fs.readFileSync('probes/r316/douyin-rpa-two-once.mjs', 'utf8');
  const fn = /const raw = await page\.evaluate\((\(\) => \{[\s\S]*?\n    \})\)\.catch\(\(\) => null\);/.exec(src)?.[1];
  assert.ok(fn);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext(); await ctx.route('**/*', r => r.abort('blockedbyclient'));
    const page = await ctx.newPage();
    await page.setContent('<main data-e2e="user-detail-9"><section data-e2e="live-replay"><a href="https://www.douyin.com/video/7000000000000000001"><span>直播回放 SECRET_TITLE 11-13</span></a></section></main>');
    const raw = await page.evaluate('(' + fn + ')()');
    assert.equal(raw.replay.textNodes, 1);
    assert.deepEqual(raw.replay.ancestry[0].slice(0, 4), ['span', 'a', 'section[live-replay]', 'main[user-detail-]']);
    assert.doesNotMatch(JSON.stringify(raw.replay.ancestry), /SECRET_TITLE|\d/);   // labels only: no text, no ids
    await page.setContent('<main><p>没有回放</p></main>');
    assert.deepEqual(await page.evaluate('(' + fn + ')()').then(r => r.replay), { textNodes: 0, ancestry: [] });
    await ctx.close();
  } finally { await browser.close(); }
});
