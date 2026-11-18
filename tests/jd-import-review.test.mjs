// Independent review regressions. All workbooks and identities are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {previewExports} from '../experiments/jd-export-import/import.mjs';
import {persistPreview} from '../experiments/jd-export-import/store.mjs';

const python = process.platform === 'win32' ? 'python' : 'python3';
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'experiments/jd-export-import/cli.mjs');
const mapping = {schemaVersion: 1, sourceType: 'JD_MERCHANT_EXPORT_UNVERIFIED',
  evidenceKind: 'synthetic', exportedAt: '2026-11-17T03:00:00Z',
  columns: {accountId: 'account', sessionId: 'session', startedAt: 'start', endedAt: 'end', sourceId: 'source'}};
const headers = ['account', 'session', 'start', 'end', 'source'];
const row = (account = '001', session = 'session-a') =>
  [account, session, '2026-11-17T01:00:00Z', '2026-11-17T02:00:00Z', 'fixture-source'];
const csv = (rows = [row()]) => [headers, ...rows].map(r => r.join(',')).join('\n');
const preview = text => previewExports({files: [{format: 'csv', text}], mapping, now: '2026-11-18T00:00:00Z'});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function temp(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-import-review-'));
  fs.chmodSync(parent, 0o700);
  t.after(() => {
    const resolved = path.resolve(parent);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^jd-import-review-/);
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const directory = path.join(parent, 'private-store');
  fs.mkdirSync(directory, {mode: 0o700});
  const mappingFile = path.join(parent, 'mapping.json');
  fs.writeFileSync(mappingFile, JSON.stringify(mapping));
  return {parent, directory, mappingFile};
}
function workbook({phonetic = null} = {}) {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const docrel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheet = (data, first) => '<worksheet xmlns="' + main + '"><sheetData>' + [headers, data]
    .map((r, rn) => '<row r="' + (rn + 1) + '">' + r.map((text, cn) => {
      const ref = String.fromCharCode(65 + cn) + (rn + 1);
      if (first && rn === 1 && cn === 0 && phonetic === 'shared') return '<c r="' + ref + '" t="s"><v>0</v></c>';
      const extra = first && rn === 1 && cn === 0 && phonetic === 'inline' ? '<rPh sb="0" eb="3"><t>9</t></rPh>' : '';
      return '<c r="' + ref + '" t="inlineStr"><is><t>' + text + '</t>' + extra + '</is></c>';
    }).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': '<workbook xmlns="' + main + '" xmlns:r="' + docrel + '"><sheets><sheet name="First" sheetId="1" r:id="r1"/><sheet name="Second" sheetId="2" r:id="r2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="' + docrel + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="' + docrel + '/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet(row('001', 'session-a'), true),
    'xl/worksheets/sheet2.xml': sheet(row('002', 'session-b'), false),
  };
  if (phonetic === 'shared') parts['xl/sharedStrings.xml'] = '<sst xmlns="' + main + '"><si><t>001</t><rPh sb="0" eb="3"><t>9</t></rPh></si></sst>';
  const maker = 'import sys,json,io,zipfile\np=json.load(sys.stdin); b=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:\n for k,v in p.items(): z.writestr(k,v)\nsys.stdout.buffer.write(b.getvalue())';
  const result = spawnSync(python, ['-c', maker], {input: JSON.stringify(parts), timeout: 10000, windowsHide: true});
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
  return result.stdout;
}
function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true});
}

test('review: importing different equal-height sheets from the SAME workbook preserves both batches', t => {
  const {parent, directory, mappingFile} = temp(t);
  const file = path.join(parent, 'FICTIONAL-two-sheets.xlsx');
  fs.writeFileSync(file, workbook());
  const common = ['--input', file, '--mapping', mappingFile, '--store', directory];
  const first = run([...common, '--sheet', 'First', '--initialize-store', 'true']);
  assert.equal(first.status, 0, first.stderr);
  const second = run([...common, '--sheet', 'Second']);
  assert.equal(second.status, 0, second.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'history.json'), 'utf8'));
  assert.equal(state.batches.length, 2);
  assert.equal(state.counts.historicalRecords, 2);
  assert.notEqual(state.batches[0].batchId, state.batches[1].batchId);
  assert.equal(state.batches[0].files[0].sha256, state.batches[1].files[0].sha256);
  assert.deepEqual(state.batches.map(b => b.files[0].sourceSheet), ['First', 'Second']);
  assert.deepEqual(state.records.map(r => r.accountId).sort(), ['001', '002']);
  assert.ok(state.records.every(r => r.currentState === 'UNKNOWN' && r.historicalOnly));
  const repeat = run([...common, '--sheet', 'Second']);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'history.json'), 'utf8')).batches.length, 2);
});

test('review: shared and inline phonetic nodes are rejected rather than appended to IDs', t => {
  for (const phonetic of ['shared', 'inline']) {
    const {parent, directory, mappingFile} = temp(t);
    const file = path.join(parent, 'FICTIONAL-phonetic.xlsx');
    fs.writeFileSync(file, workbook({phonetic}));
    const result = run(['--input', file, '--mapping', mappingFile, '--store', directory, '--sheet', 'First', '--initialize-store', 'true']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'JD_EXPORT_XLSX_REQUIRES_REVIEW');
    assert.equal(fs.existsSync(path.join(directory, 'history.json')), false);
  }
});

test('review: partial row errors remain visible after reopening and later successful imports', t => {
  const {parent, directory, mappingFile} = temp(t);
  const partial = path.join(parent, 'partial.csv'), next = path.join(parent, 'next.csv');
  fs.writeFileSync(partial, csv([row(), row('=PRIVATE_FORMULA', 'bad-session')]));
  fs.writeFileSync(next, csv([row('002', 'session-b')]));
  const first = run(['--input', partial, '--mapping', mappingFile, '--store', directory, '--initialize-store', 'true']);
  assert.equal(first.status, 2, first.stderr);
  assert.equal(JSON.parse(first.stdout).errorRows, 1);
  const second = run(['--input', next, '--mapping', mappingFile, '--store', directory]);
  assert.ok([0, 2].includes(second.status), second.stderr);
  assert.equal(JSON.parse(second.stdout).errorRows, 1);
  const stateText = fs.readFileSync(path.join(directory, 'history.json'), 'utf8');
  const state = JSON.parse(stateText);
  assert.deepEqual(state.batches[0].errors, [{fileIndex: 0, row: 3, code: 'FORMULA_LIKE_CELL_REJECTED'}]);
  assert.equal(state.counts.historicalRecords, 2);
  assert.equal(state.counts.errorRows, 1);
  assert.ok(!stateText.includes('PRIVATE_FORMULA'));
});

test('review: a wholly unparseable batch does not initialize empty success history', t => {
  const {parent, directory, mappingFile} = temp(t);
  const file = path.join(parent, 'broken.csv');
  fs.writeFileSync(file, '"unterminated');
  const result = run(['--input', file, '--mapping', mappingFile, '--store', directory, '--initialize-store', 'true']);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(path.join(directory, 'history.json')), false);
});

test('review: a replaced lock owner is preserved and cannot authorize snapshot publication', t => {
  const {directory} = temp(t);
  const first = preview(csv());
  persistPreview({directory, preview: first, mapping, initialize: true});
  const before = fs.readFileSync(path.join(directory, 'history.json'));
  const ownerFile = path.join(directory, '.import-lock', 'owner.json');
  const replacement = '{"operationId":"another-writer"}';
  assert.throws(() => persistPreview({directory, preview: preview(csv([row('002', 'session-b')])), mapping,
    fault: stage => {if (stage === 'before-commit') fs.writeFileSync(ownerFile, replacement);}}), /JD_EXPORT_STORE_BLOCKED/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'history.json')), before);
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), replacement);
});

test('review: parent directory replacement leaves original lock and replacement directory untouched', t => {
  const {parent, directory} = temp(t);
  persistPreview({directory, preview: preview(csv()), mapping, initialize: true});
  const old = path.join(parent, 'displaced-store');
  assert.throws(() => persistPreview({directory, preview: preview(csv([row('002', 'session-b')])), mapping,
    fault: stage => {
      if (stage === 'before-commit') {
        fs.renameSync(directory, old);
        fs.mkdirSync(directory, {mode: 0o700});
        fs.writeFileSync(path.join(directory, 'sentinel'), 'unchanged');
      }
    }}), /JD_EXPORT_STORE_BLOCKED/);
  assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(path.join(directory, 'history.json')), false);
  assert.ok(fs.existsSync(path.join(old, '.import-lock', 'owner.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(old, 'history.json'), 'utf8')).revision, 1);
});

test('review: recomputed checksum cannot excuse mismatched provenance and file schema', t => {
  const mutations = [
    s => {s.batches[0].files[0].rowCount = 0;},
    s => {s.batches[0].rows[0].provenance[0].fileSha256 = 'a'.repeat(64);},
    s => {s.batches[0].rows[0].provenance[0].fileIndex = 1;},
    s => {s.batches[0].files[0].sourceFormat = 'unknown';},
    s => {s.batches[0].errors = [{fileIndex: 0, row: 2, code: 'UNTRUSTED_DETAIL'}];},
  ];
  for (const mutate of mutations) {
    const {directory} = temp(t);
    persistPreview({directory, preview: preview(csv()), mapping, initialize: true});
    const file = path.join(directory, 'history.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(state);
    const {checksum, ...payload} = state;
    fs.writeFileSync(file, JSON.stringify({...payload, checksum: digest(payload)}));
    const before = fs.readFileSync(file);
    assert.throws(() => persistPreview({directory, preview: preview(csv([row('002', 'session-b')])), mapping}), /JD_EXPORT_STORE_BLOCKED/);
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

test('review: malformed preview references and digest types are rejected before first publication', t => {
  const changes = [
    p => {p.fileSummaries[0].sha256 = [p.fileSummaries[0].sha256];},
    p => {p.fileSummaries[0].parsedSha256 = [p.fileSummaries[0].parsedSha256];},
    p => {p.records[0].provenance[0].fileSha256 = [p.records[0].provenance[0].fileSha256];},
    p => {p.records[0].provenance[0].fileSha256 = 'a'.repeat(64);},
    p => {p.records[0].provenance[0].fileIndex = 1;},
    p => {p.records[0].provenance[0].row = 3;},
    p => {p.errors = [{fileIndex: 0, row: 3, code: 'TIME_ORDER_INVALID'}];},
    p => {p.errors = [{fileIndex: 1, row: 2, code: 'TIME_ORDER_INVALID'}];},
    p => {p.errors = [{fileIndex: 0, row: null, code: 'CSV_INVALID'}];},
    p => {
      const r = p.records[0];
      r.startedAt = '2026-11-17T01:00:00+00:00';
      r.recordHash = digest({accountId: r.accountId, sessionId: r.sessionId,
        sourceId: r.sourceId, startedAt: r.startedAt, endedAt: r.endedAt});
    },
  ];
  for (const mutate of changes) {
    const {directory} = temp(t);
    const input = preview(csv());
    mutate(input);
    assert.throws(() => persistPreview({directory, preview: input, mapping, initialize: true}), /JD_EXPORT_STORE_BLOCKED/);
    assert.equal(fs.existsSync(path.join(directory, 'history.json')), false);
  }
});

test('review: file-level parse failure may coexist with a valid file and keeps fixed errors', t => {
  const {directory} = temp(t);
  const input = previewExports({files: [{format: 'csv', text: '"unterminated'}, {format: 'csv', text: csv()}],
    mapping, now: '2026-11-18T00:00:00Z'});
  const result = persistPreview({directory, preview: input, mapping, initialize: true});
  assert.equal(result.counts.historicalRecords, 1);
  assert.equal(result.counts.errorRows, 1);
  assert.deepEqual(result.batches[0].errors, [{fileIndex: 0, row: null, code: 'CSV_QUOTE_INVALID'}]);
  assert.equal(result.batches[0].files[0].fileIndex, 1);
  assert.equal(result.records[0].provenance[0].fileIndex, 1);
});
