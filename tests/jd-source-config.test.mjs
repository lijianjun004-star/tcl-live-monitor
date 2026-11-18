import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {checkJdSourceConfiguration, parseJdSourceOrigin} from '../probes/lib/jd-source-config.mjs';
import {networkReader, scanJdSource, SOURCE_ROUTES} from '../probes/lib/tcl-jd-all.mjs';

const ready = 'https://jd-approved.example.invalid:443';
const legacy = 'http://jd-legacy.example.invalid/';

test('preflight blocks missing, conflicting and old origins without claiming reachability', () => {
  const cases = [
    [{configured: '', approved: ready}, 'SOURCE_CONFIG_MISSING'],
    [{configured: legacy, approved: ready, legacy: legacy.slice(0, -1)}, 'LEGACY_ORIGIN_REQUIRES_REVIEW'],
    [{configured: ready, approved: ready, legacy: 'broken'}, 'LEGACY_ORIGIN_REFERENCE_INVALID'],
    [{configured: ready}, 'APPROVED_ORIGIN_REQUIRED'],
    [{configured: ready, approved: 'broken'}, 'APPROVED_ORIGIN_INVALID'],
    [{configured: ready, approved: 'https://other.example.invalid'}, 'APPROVED_ORIGIN_MISMATCH'],
    [{configured: ready, approved: ready.replace(':443', '/'), legacy}, 'APPROVED_ORIGIN_MATCH'],
  ];
  for (const [input, code] of cases) {
    const result = checkJdSourceConfiguration(input);
    assert.deepEqual(result, {
      status: code === 'APPROVED_ORIGIN_MATCH' ? 'CONFIG_MATCH' : 'BLOCKED',
      code, reachability: 'NOT_TESTED', networkRequests: 0,
    });
    assert.doesNotMatch(JSON.stringify(result), /example\.invalid|https?:/);
  }
});

test('collector rejects implicit URL repairs and origin suffixes before issuing a request', () => {
  const cases = [
    ['wrong.example.invalid', 'BASE_URL_INVALID'],
    ['https:/jd-approved.example.invalid', 'BASE_URL_INVALID'],
    ['https://jd-approved.example.invalid:/', 'BASE_URL_INVALID'],
    ['https://jd-approved.example.invalid:65536', 'BASE_URL_INVALID'],
    ['https://jd-approved.example.invalid\n', 'BASE_URL_INVALID'],
    ['https://jd-approved.example.invalid\\', 'BASE_URL_INVALID'],
    ['ftp://jd-approved.example.invalid', 'BASE_PROTOCOL_INVALID'],
    ['https://NAME:SYNTHETIC_PRIVATE_VALUE@jd-approved.example.invalid', 'BASE_MUST_BE_ORIGIN'],
    ['https://jd-approved.example.invalid/api/..', 'BASE_MUST_BE_ORIGIN'],
    ['https://jd-approved.example.invalid/?', 'BASE_MUST_BE_ORIGIN'],
    ['https://jd-approved.example.invalid/#', 'BASE_MUST_BE_ORIGIN'],
  ];
  const never = () => assert.fail('Invalid configuration reached the transport');
  for (const [value, code] of cases) {
    assert.throws(() => networkReader(value, never), {message: code});
    assert.deepEqual(checkJdSourceConfiguration({configured: value, approved: ready}), {
      status: 'BLOCKED',
      code, reachability: 'NOT_TESTED', networkRequests: 0,
    });
  }
});

test('valid HTTP(S) sources retain bounded GET behavior and classify transport failures separately', async () => {
  assert.equal(parseJdSourceOrigin('http://localhost:8080/').origin, 'http://localhost:8080');
  assert.equal(parseJdSourceOrigin('HTTPS://SOURCE.EXAMPLE.INVALID/').origin, 'https://source.example.invalid');
  let calls = 0;
  const reader = networkReader(ready, async (url, options) => {
    calls++;
    assert.equal(url.pathname, SOURCE_ROUTES.rooms);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    throw new TypeError('SYNTHETIC_PRIVATE_VALUE', {
      cause: {code: 'UND_ERR_CONNECT_TIMEOUT'},
    });
  });
  const result = await scanJdSource({reader});
  assert.equal(calls, 1);
  assert.deepEqual(result.errors, [{stage: 'CATALOG', code: 'CONNECT_TIMEOUT'}]);
  assert.equal(result.samplingStatus, 'FAILED');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_VALUE|example\.invalid/);
});

test('preflight rejects ambiguous numeric hosts while keeping explicit IP and DNS origins', () => {
  const approved = 'http://192.0.2.1';
  assert.throws(() => parseJdSourceOrigin('http://192.0.513'), {message:'BASE_URL_INVALID'});
  assert.equal(checkJdSourceConfiguration({configured:'http://192.0.513', approved}).code, 'BASE_URL_INVALID');
  assert.equal(parseJdSourceOrigin(approved + ':80/').origin, approved);
  assert.equal(parseJdSourceOrigin('https://[2001:0db8::1]:8443/').origin, 'https://[2001:db8::1]:8443');
  assert.equal(parseJdSourceOrigin('https://例子.invalid/').hostname, 'xn--fsqu00a.invalid');
});

test('operator CLI emits fixed output and never needs a live endpoint', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  function run(configured, approved, fallback = '') {
    return spawnSync(process.execPath, ['scripts/check-jd-source-config.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {...process.env, TCL_OPS_BASE_URL: configured, JD_APPROVED_SOURCE_ORIGIN: approved,
        JD_LEGACY_SOURCE_ORIGIN: fallback},
    });
  }
  const pass = run(ready, ready);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).reachability, 'NOT_TESTED');
  const block = run('https://user:SYNTHETIC_PRIVATE_VALUE@jd-approved.example.invalid/', ready);
  assert.equal(block.status, 2, block.stderr);
  assert.equal(JSON.parse(block.stdout).code, 'BASE_MUST_BE_ORIGIN');
  assert.doesNotMatch(block.stdout + block.stderr, /SYNTHETIC_PRIVATE_VALUE|example\.invalid/);
});
