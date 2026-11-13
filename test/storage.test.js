import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptionKey, encrypt, decrypt, hashSecret, CloudflareStore } from '../lib/storage.js';

test('authenticated encryption round trips and binds data to its owner', () => {
  const key = encryptionKey(randomBytes(32).toString('base64'));
  const encrypted = encrypt({ access_token: 'secret', refresh_token: 'rotate' }, key, 'buffer:user-a');
  assert.equal(encrypted.includes('secret'), false);
  assert.deepEqual(decrypt(encrypted, key, 'buffer:user-a'), { access_token: 'secret', refresh_token: 'rotate' });
  assert.throws(() => decrypt(encrypted, key, 'buffer:user-b'));
  const parts = encrypted.split('.'); parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), key, 'buffer:user-a'));
  assert.throws(() => encryptionKey('invalid'));
});
test('session identifiers are stored as hashes', () => {
  assert.equal(hashSecret('a').length, 64); assert.notEqual(hashSecret('a'), 'a'); assert.notEqual(hashSecret('a'), hashSecret('b'));
});
test('D1 storage encrypts tokens and sends parameterized queries', async () => {
  const originalFetch = globalThis.fetch; let saved;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer server-secret');
    const request = JSON.parse(options.body);
    if (request.sql.startsWith('INSERT INTO buffer_connections')) { saved = request.params; return Response.json({ success: true, result: [{ success: true, results: [] }] }); }
    assert.match(request.sql, /user_id = \?/); assert.equal(request.params[0], 'user-a');
    return Response.json({ success: true, result: [{ success: true, results: [{ encrypted_tokens: saved[1], refreshing: 0 }] }] });
  };
  try {
    const store = new CloudflareStore({ accountId: 'a'.repeat(32), databaseId: '12345678-1234-1234-1234-123456789012', apiToken: 'server-secret', key: randomBytes(32).toString('base64') });
    await store.saveConnection('user-a', { access_token: 'secret-token', refresh_token: 'secret-refresh' });
    assert.equal(JSON.stringify(saved).includes('secret-token'), false);
    assert.deepEqual((await store.connection('user-a')).tokens, { access_token: 'secret-token', refresh_token: 'secret-refresh' });
  } finally { globalThis.fetch = originalFetch; }
});
