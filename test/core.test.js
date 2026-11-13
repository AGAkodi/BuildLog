import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepo, challenge, safeEqual, createDraft, isAllowedOrigin } from '../lib/core.js';

test('accepts only public GitHub repository identifiers', () => {
  assert.deepEqual(parseRepo('https://github.com/AGAkodi/BuildLog.git'), { owner: 'AGAkodi', repo: 'BuildLog' });
  assert.deepEqual(parseRepo('owner/repo'), { owner: 'owner', repo: 'repo' });
  for (const value of ['https://github.com.evil.test/a/b', 'https://github.com/a/b/issues', 'http://github.com/a/b', '../repo', 'https://user@github.com/a/b']) assert.throws(() => parseRepo(value));
});
test('PKCE challenge follows S256 test vector', () => {
  assert.equal(challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(safeEqual('abc', 'abc'), true); assert.equal(safeEqual('abc', 'abcd'), false);
});
test('draft states merged rather than live and includes source', () => {
  const result = createDraft({ title: 'Add profile editor', url: 'https://github.com/a/b/pull/1' });
  assert.match(result, /Just merged: Add profile editor/); assert.match(result, /https:\/\/github.com\/a\/b\/pull\/1/); assert.doesNotMatch(result, /live|shipped/i);
});
test('mutation origin must match application origin', () => {
  assert.equal(isAllowedOrigin('https://buildlog.example', 'https://buildlog.example'), true);
  assert.equal(isAllowedOrigin('https://evil.example', 'https://buildlog.example'), false);
  assert.equal(isAllowedOrigin(undefined, 'https://buildlog.example'), false);
});
