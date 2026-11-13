// R3.26: the scheduled Douyin daily workflow keeps its approved, read-only shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const file = '.github/workflows/douyin-daily-broadcast.yml';
test('scheduled daily workflow: schedule + manual only, read-only token, main only, cooldown, no plaintext private data', { skip: !fs.existsSync(file) }, () => {
  const wf = fs.readFileSync(file, 'utf8');
  assert.match(wf, /\non:\n  schedule:\n    - cron: '17 0-16\/2 \* \* \*'[^\n]*\n  workflow_dispatch:\npermissions:\n  contents: read\n  actions: read\n/);
  assert.doesNotMatch(wf, /pull_request|\n  push:|contents: write|secrets\./);
  assert.match(wf, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(wf, /age<24\*3600e3/);
  assert.equal((wf.match(/node probes\/r316\/douyin-rpa-two-once\.mjs/g) || []).length, 1);
  assert.match(wf, /pass a "" \|\| stopped=1\n\s+if \[ "\$stopped" = 0 \]; then sleep 5; pass b SCORING_B \|\| stopped=1; fi/);
  assert.match(wf, /rm -rf out\/private-\*/);
  const uploads = wf.split('uses: actions/upload-artifact@v4').slice(1).join('\n');
  assert.doesNotMatch(uploads, /private-a|private-b|receipt-|r316-private/);
  assert.match(wf, /--evidence-kind real/);
});
