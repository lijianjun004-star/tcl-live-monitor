import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedRpaDocumentRequest as allowed } from '../../probes/r315/rpa-network-policy.mjs';

const profile = 'https://www.douyin.com/user/MS4wLjABAAAA' + 'a'.repeat(24);
const room = 'https://live.douyin.com/123456789';
const request = (overrides = {}) => ({ url: profile, method: 'GET', resourceType: 'document', isNavigationRequest: true, ...overrides });

test('permits only exact explicitly allowed public document navigations', () => {
  assert.equal(allowed(request(), [profile, room]), true);
  assert.equal(allowed(request({ url: room, method: 'HEAD' }), [profile, room]), true);
  assert.equal(allowed(request({ url: room }), [profile]), false);
});

test('rejects methods, subresources, media and non-navigation traffic', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'get', undefined]) {
    assert.equal(allowed(request({ method }), [profile]), false);
  }
  for (const resourceType of ['xhr', 'fetch', 'media', 'websocket', 'script', 'stylesheet', 'image', 'other', undefined]) {
    assert.equal(allowed(request({ resourceType }), [profile]), false);
  }
  assert.equal(allowed(request({ isNavigationRequest: false }), [profile]), false);
  assert.equal(allowed(request({ isNavigationRequest: undefined }), [profile]), false);
});

test('rejects unapproved hosts, paths, account URLs, queries and redirects', () => {
  const bad = [
    'https://evil.example/user/MS4wLjABAAAA' + 'a'.repeat(24),
    'http://www.douyin.com/user/MS4wLjABAAAA' + 'a'.repeat(24),
    'https://www.douyin.com/api/comments',
    'https://www.douyin.com/user/other',
    'https://live.douyin.com/123456789?comment=1',
    'https://live.douyin.com/123456789#fragment',
    'https://user@live.douyin.com/123456789',
    'https://live.douyin.com:444/123456789',
    'wss://live.douyin.com/123456789',
  ];
  for (const url of bad) {
    assert.equal(allowed(request({ url }), [profile]), false);
    assert.equal(allowed(request(), [profile, url]), false);
  }
});

test('rejects malformed or ambiguous allowlists and requests', () => {
  for (const list of [undefined, [], [profile, profile], [null], Array(5).fill(profile)]) {
    assert.equal(allowed(request(), list), false);
  }
  for (const req of [null, {}, [], { ...request(), url: undefined }]) {
    assert.equal(allowed(req, [profile]), false);
  }
});
