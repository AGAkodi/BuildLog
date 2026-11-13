import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export function hashSecret(value) { return createHash('sha256').update(value).digest('hex'); }
export function encryptionKey(value) {
  const key = Buffer.from(value || '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('BUFFER_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return key;
}
export function encrypt(value, key, context) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function decrypt(value, key, context) {
  const [version, nonce, tag, ciphertext, extra] = String(value).split('.');
  if (version !== 'v1' || !nonce || !tag || !ciphertext || extra !== undefined) throw new Error('Invalid encrypted data.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}
export class CloudflareStore {
  constructor({ accountId, databaseId, apiToken, key }) {
    if (!/^[a-f0-9]{32}$/i.test(accountId || '') || !/^[a-f0-9-]{36}$/i.test(databaseId || '') || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID and CLOUDFLARE_API_TOKEN are required.');
    this.url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.apiToken = apiToken; this.key = encryptionKey(key);
  }
  async query(sql, params = []) {
    const response = await fetch(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || !result.success || !result.result?.[0]?.success) throw new Error('Account storage is unavailable. Please try again.');
    return result.result[0];
  }
  async getSession(hash) { const r = await this.query('SELECT user_id, email, expires_at FROM sessions WHERE id_hash = ? AND expires_at > ?', [hash, Date.now()]); return r.results[0] || null; }
  async createSession(hash, user) { await this.query('INSERT INTO sessions (id_hash, user_id, email, expires_at) VALUES (?, ?, ?, ?)', [hash, user.id, user.email, Date.now() + 7 * 86400000]); }
  async deleteSession(hash) { await this.query('DELETE FROM sessions WHERE id_hash = ?', [hash]); }
  async deleteAccount(userId) {
    const statements = [
      ['DELETE FROM oauth_transactions WHERE user_id = ? OR session_hash IN (SELECT id_hash FROM sessions WHERE user_id = ?)', [userId, userId]],
      ['DELETE FROM buffer_connections WHERE user_id = ?', [userId]],
      ['DELETE FROM submissions WHERE user_id = ?', [userId]],
      ['DELETE FROM sessions WHERE user_id = ?', [userId]]
    ];
    for (const [sql, params] of statements) await this.query(sql, params);
  }

  async connection(userId) { const r = await this.query('SELECT encrypted_tokens, refreshing FROM buffer_connections WHERE user_id = ?', [userId]); if (!r.results.length) return null; const row = r.results[0]; return { tokens: decrypt(row.encrypted_tokens, this.key, `buffer:${userId}`), encryptedTokens: row.encrypted_tokens, refreshing: !!row.refreshing }; }
  async saveConnection(userId, tokens) { await this.query('INSERT INTO buffer_connections (user_id, encrypted_tokens, refreshing, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_tokens = excluded.encrypted_tokens, refreshing = 0, updated_at = excluded.updated_at', [userId, encrypt(tokens, this.key, `buffer:${userId}`), Date.now()]); }
  async deleteConnection(userId) { await this.query('DELETE FROM buffer_connections WHERE user_id = ?', [userId]); }
  async claimRefresh(userId) { const r = await this.query('UPDATE buffer_connections SET refreshing = 1 WHERE user_id = ? AND refreshing = 0 RETURNING user_id', [userId]); return r.results.length === 1; }
  async finishRefresh(userId, previous, tokens) { const r = await this.query('UPDATE buffer_connections SET encrypted_tokens = ?, refreshing = 0, updated_at = ? WHERE user_id = ? AND encrypted_tokens = ? AND refreshing = 1 RETURNING user_id', [encrypt(tokens, this.key, `buffer:${userId}`), Date.now(), userId, previous]); if (!r.results.length) throw new Error('Buffer connection changed during refresh. Please retry.'); }
  async saveOAuth(state, sessionHash, userId, verifier, provider = 'buffer') { await this.query('INSERT INTO oauth_transactions (state_hash, session_hash, user_id, provider, encrypted_verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [hashSecret(state), sessionHash, userId, provider, encrypt(verifier, this.key, `oauth:${provider}:${userId || sessionHash}`), Date.now() + 600000]); }
  async consumeOAuth(state, sessionHash, provider = 'buffer') { const r = await this.query('DELETE FROM oauth_transactions WHERE state_hash = ? AND session_hash = ? AND provider = ? AND expires_at > ? RETURNING user_id, encrypted_verifier', [hashSecret(state), sessionHash, provider, Date.now()]); if (!r.results.length) return null; const row = r.results[0]; return { userId: row.user_id, verifier: decrypt(row.encrypted_verifier, this.key, `oauth:${provider}:${row.user_id || sessionHash}`) }; }
}
