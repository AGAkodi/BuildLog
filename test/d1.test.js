import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { CloudflareStore, hashSecret } from '../lib/storage.js';

test('D1 SQL preserves sessions and isolates connections through refresh and OAuth', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    try {
      const statement = db.prepare(sql);
      const rows = /^(SELECT|.*\bRETURNING\b)/i.test(sql) ? statement.all(...params) : (statement.run(...params), []);
      return Response.json({ success: true, result: [{ success: true, results: rows }] });
    } catch (error) { return Response.json({ success: false, errors: [{ message: error.message }] }, { status: 400 }); }
  };
  try {
    const config = { accountId: 'a'.repeat(32), databaseId: '12345678-1234-1234-1234-123456789012', apiToken: 'server-secret', key: randomBytes(32).toString('base64') };
    const a = new CloudflareStore(config), b = new CloudflareStore(config);
    await a.createSession(hashSecret('session-a'), { id: 'github:1', email: 'alice' });
    assert.equal((await b.getSession(hashSecret('session-a'))).user_id, 'github:1');
    await a.saveConnection('github:1', { access_token: 'first', refresh_token: 'rotate' });
    assert.equal(await b.connection('github:2'), null);
    assert.equal(await a.claimRefresh('github:1'), true);
    assert.equal(await b.claimRefresh('github:1'), false);
    const initial = await b.connection('github:1');
    await b.finishRefresh('github:1', initial.encryptedTokens, { access_token: 'second', refresh_token: 'new' });
    assert.equal((await a.connection('github:1')).tokens.access_token, 'second');
    await assert.rejects(a.finishRefresh('github:1', initial.encryptedTokens, { access_token: 'stale' }));
    await a.saveOAuth('state', hashSecret('browser'), 'github:1', 'verifier');
    assert.equal(await b.consumeOAuth('state', hashSecret('other')), null);
    assert.equal((await b.consumeOAuth('state', hashSecret('browser'))).verifier, 'verifier');
    assert.equal(await b.consumeOAuth('state', hashSecret('browser')), null);
    await b.deleteSession(hashSecret('session-a'));
    assert.equal(await a.getSession(hashSecret('session-a')), null);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
