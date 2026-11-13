CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS buffer_connections (user_id TEXT PRIMARY KEY, encrypted_tokens TEXT NOT NULL, refreshing INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_transactions (state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, user_id TEXT, provider TEXT NOT NULL, encrypted_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth_transactions(expires_at);
CREATE TABLE IF NOT EXISTS submissions (idempotency_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, status_code INTEGER NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS submissions_user ON submissions(user_id);
