// R3.16 static guards: public outputs carry no internal identifiers; R3.16 workflows are bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = p => fs.readFileSync(p, 'utf8');
const wf = fs.readdirSync('.github/workflows').filter(f => /^r316-/.test(f)).map(f => path.join('.github/workflows', f));

test('R3.16 workflows: push on the experiment branch only, token-gated, no schedule, read-only token, bounded time', () => {
  assert.ok(wf.length >= 3);
  for (const f of wf) {
    const s = read(f);
    if (/offline-gate/.test(f)) { assert.match(s, /pull_request:/); assert.doesNotMatch(s, /101\.96\.215\.251/); continue; }
    assert.doesNotMatch(s, /\bschedule:/, f); assert.match(s, /branches: \[experiment\/r316-jd-douyin-current-chain-20261112\]/, f);
    assert.match(s, /if: contains\(github\.event\.head_commit\.message, '\[r316-[a-z-]+\]'\)/, f);
    assert.match(s, /permissions:\s*\n\s*contents: read/, f); assert.match(s, /timeout-minutes: (?:[1-9]|10)\b/, f);
    assert.doesNotMatch(s, /upload-artifact[\s\S]*private/, f);
  }
});
test('switch workflow encrypts per-room detail and never uploads it', () => {
  const s = read('.github/workflows/r315-switchable-one-shot.yml');
  assert.match(s, /pkeyutl -encrypt -pubin -inkey probes\/keys\/analysis-pub\.pem/);
  assert.match(s, /rm -f k\.bin r316-private-run\.json/);
  const upload = s.slice(s.indexOf('upload-artifact'));
  assert.doesNotMatch(upload, /private/);
});
test('public log lines of R3.16 probes never print ids, names or query strings', () => {
  for (const f of ['probes/r316/source-extract-once.mjs', 'probes/r316/douyin-rpa-two-once.mjs', 'probes/r316/one-shot-cli.mjs']) {
    const logs = read(f).split('\n').filter(l => /console\.log\(/.test(l));
    for (const l of logs) assert.doesNotMatch(l, /roomId|shopId|secUid|profileUrl|u\.search|anchor|name\b|priv\b/, `${f}: ${l.trim().slice(0, 90)}`);
  }
});
test('docs/r316 contain no internal ids, query strings, secUids or staff fields', () => {
  if (!fs.existsSync('docs/r316')) return;
  for (const f of fs.readdirSync('docs/r316')) {
    const s = read(path.join('docs/r316', f));
    assert.doesNotMatch(s, /live_room_id=\d|shop_id=\d|MS4wLjABAAAA|bound_session_key"?\s*:\s*"|anchor_name"?\s*:\s*"/, f);
  }
});
