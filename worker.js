import { randomToken, challenge, safeEqual, parseRepo, createDraftOptions, isAllowedOrigin } from './lib/core.js';
import { CloudflareStore, hashSecret } from './lib/storage.js';
import { assets } from './cloudflare/assets.js';

export async function handleRequest(request, env) {
const appUrl = env.APP_URL;
if (!appUrl || new URL(appUrl).protocol !== 'https:' || !env.DB || !env.BUFFER_TOKEN_ENCRYPTION_KEY) return new Response('Server configuration incomplete', {status: 503});
const redirectUri = env.BUFFER_REDIRECT_URI || `${appUrl}/api/buffer/callback`;
class BoundStore extends CloudflareStore {
  constructor() { super({ accountId: '0'.repeat(32), databaseId: '00000000-0000-0000-0000-000000000000', apiToken: 'binding', key: env.BUFFER_TOKEN_ENCRYPTION_KEY }); }
  async query(sql, params = []) { return env.DB.prepare(sql).bind(...params).all(); }
  async deleteAccount(userId) {
    const statements = [
      ['DELETE FROM oauth_transactions WHERE user_id = ? OR session_hash IN (SELECT id_hash FROM sessions WHERE user_id = ?)', [userId, userId]],
      ['DELETE FROM buffer_connections WHERE user_id = ?', [userId]],
      ['DELETE FROM submissions WHERE user_id = ?', [userId]],
      ['DELETE FROM sessions WHERE user_id = ?', [userId]]
    ];
    await env.DB.batch(statements.map(([sql, params]) => env.DB.prepare(sql).bind(...params)));
  }

}
const store = new BoundStore();
const secure = true;
const cookieOptions = `HttpOnly; SameSite=Lax; Path=/; Max-Age=604800; Secure`;
const mime = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/privacy': ['privacy.html', 'text/html; charset=utf-8'], '/logo.svg': ['logo.svg', 'image/svg+xml'] };
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }
function redirect(res, location) { res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }); res.end(); }
async function session(req) {
  const token = (req.headers.cookie || '').split(';').map(x => x.trim().split('=')).find(x => x[0] === 'buildlog_session')?.[1];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = hashSecret(token), record = await store.getSession(id);
  return record ? { id, userId: record.user_id, email: record.email } : null;
}
function requireSession(s) { if (!s) throw new Error('Sign in to continue.'); return s; }
async function startSession(res, user) {
  const token = randomToken(); await store.createSession(hashSecret(token), user);
  res.setHeader('Set-Cookie', `buildlog_session=${token}; ${cookieOptions}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', `buildlog_session=; ${cookieOptions}; Max-Age=0`); }
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 20000) throw new Error('Request too large.'); }
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Invalid request.'); }
}
async function github(path) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'BuildLog', 'X-GitHub-Api-Version': '2022-11-28' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(response.status === 404 ? 'Repository not found or not public.' : response.status === 403 || response.status === 429 ? 'GitHub rate limit reached. Try again later.' : `GitHub request failed (${response.status}).`);
  return response.json();
}
async function tokenRequest(params) {
  const response = await fetch('https://auth.buffer.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Buffer token endpoint returned HTTP ${response.status}.`);
  return response.json();
}
async function accessToken(s) {
  const connection = await store.connection(s.userId);
  if (!connection) throw new Error('Connect your Buffer account first.');
  if (connection.refreshing) throw new Error('Buffer token refresh is in progress or was interrupted. If this persists, reconnect Buffer.');
  let tokens = connection.tokens;
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60000) {
    if (!tokens.refresh_token) throw new Error('Buffer connection expired. Please reconnect.');
    if (!await store.claimRefresh(s.userId)) throw new Error('Buffer token refresh is in progress. Please retry shortly.');
    // Reread after acquiring the claim: another request may have refreshed first.
    const latest = await store.connection(s.userId);
    if (!latest || !latest.refreshing) throw new Error('Buffer connection changed. Please retry.');
    tokens = latest.tokens;
    if (tokens.expiresAt >= Date.now() + 60000) { await store.finishRefresh(s.userId, latest.encryptedTokens, tokens); return tokens.access_token; }
    const params = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: env.BUFFER_CLIENT_ID };
    if (env.BUFFER_CLIENT_SECRET) params.client_secret = env.BUFFER_CLIENT_SECRET;
    try {
      const refreshed = await tokenRequest(params);
      if (!refreshed.access_token || !refreshed.refresh_token) throw new Error('Buffer returned an incomplete token response.');
      tokens = { ...refreshed, expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000 };
      await store.finishRefresh(s.userId, latest.encryptedTokens, tokens);
    } catch {
      // Outcome can be ambiguous; never reuse a possibly consumed refresh token.
      throw new Error('Buffer refresh could not be completed. Reconnect your Buffer account.');
    }
  }
  return tokens.access_token;
}
async function buffer(s, query, variables = {}) {
  const token = await accessToken(s);
  const response = await fetch('https://api.buffer.com', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(response.status === 401 ? 'Buffer connection expired. Please reconnect.' : `Buffer request failed (${response.status}).`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join('; '));
  return result.data;
}
const handle = async (req, res) => {
  try {
    const url = new URL(req.url, appUrl), path = url.pathname;
    if (req.method === 'GET' && mime[path]) { const [file, type] = mime[path]; const content = assets[file]; res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }); return res.end(content); }
    const s = await session(req);
    const id = s?.id;
    if (req.method === 'POST' && !isAllowedOrigin(req.headers.origin, appUrl)) return json(res, 403, { error: 'Invalid request origin.' });
    if (req.method === 'GET' && path === '/api/status') {
      const connection = s ? await store.connection(s.userId) : null;
      return json(res, 200, { authenticated: !!s, email: s?.email, connected: !!connection && !connection.refreshing, reconnect: !!connection?.refreshing, configured: !!env.BUFFER_CLIENT_ID });
    }
    if (req.method === 'GET' && path === '/api/auth/github/start') {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Error('GitHub sign-in is not configured.');
      const state = randomToken(), verifier = randomToken(), browserToken = randomToken();
      await store.saveOAuth(state, hashSecret(browserToken), null, verifier, 'github');
      res.setHeader('Set-Cookie', `buildlog_login=${browserToken}; ${cookieOptions}; Max-Age=600`);
      const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: env.GITHUB_REDIRECT_URI || `${appUrl}/api/auth/github/callback`, state, code_challenge: challenge(verifier), code_challenge_method: 'S256', scope: 'read:user' });
      return redirect(res, `https://github.com/login/oauth/authorize?${params}`);
    }
    if (req.method === 'GET' && path === '/api/auth/github/callback') {
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      const browserToken = (req.headers.cookie || '').split(';').map(x => x.trim().split('=')).find(x => x[0] === 'buildlog_login')?.[1];
      res.setHeader('Set-Cookie', `buildlog_login=; ${cookieOptions}; Max-Age=0`);
      if (!state || !code || !browserToken || !/^[A-Za-z0-9_-]{43}$/.test(browserToken)) return redirect(res, '/?auth=failed');
      try {
        const transaction = await store.consumeOAuth(state, hashSecret(browserToken), 'github');
        if (!transaction) return redirect(res, '/?auth=failed');
        const response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, redirect_uri: env.GITHUB_REDIRECT_URI || `${appUrl}/api/auth/github/callback`, code, code_verifier: transaction.verifier }), signal: AbortSignal.timeout(15000) });
        const token = await response.json(); if (!response.ok || !token.access_token) throw new Error('GitHub authorization failed.');
        const identityResponse = await fetch('https://api.github.com/user', { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'BuildLog' }, signal: AbortSignal.timeout(15000) });
        const identity = await identityResponse.json();
        if (!identityResponse.ok || !Number.isSafeInteger(identity.id) || typeof identity.login !== 'string') throw new Error('GitHub identity lookup failed.');
        if (s) await store.deleteSession(s.id);
        await startSession(res, { id: `github:${identity.id}`, email: identity.login });
        return redirect(res, '/?auth=connected');
      } catch { return redirect(res, '/?auth=failed'); }
    }
    if (req.method === 'POST' && path === '/api/auth/signout') {
      if (s) await store.deleteSession(s.id);
      clearSession(res); return json(res, 200, { ok: true });
    }
    if (path.startsWith('/api/')) requireSession(s);
    if (req.method === 'POST' && path === '/api/account/delete') { await store.deleteAccount(s.userId); clearSession(res); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && path === '/api/buffer/start') {
      if (!env.BUFFER_CLIENT_ID) throw new Error('Buffer OAuth is not configured on the server.');
      const state = randomToken(), verifier = randomToken();
      await store.saveOAuth(state, id, s.userId, verifier);
      const params = new URLSearchParams({ client_id: env.BUFFER_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'account:read posts:read posts:write offline_access', prompt: 'consent', state, code_challenge: challenge(verifier), code_challenge_method: 'S256' });
      return redirect(res, `https://auth.buffer.com/auth?${params}`);
    }
    if (req.method === 'GET' && path === '/api/buffer/callback') {
      const state = url.searchParams.get('state');
      if (!state || !url.searchParams.get('code')) return redirect(res, '/?buffer=failed');
      const transaction = await store.consumeOAuth(state, id);
      if (!transaction || !safeEqual(transaction.userId, s.userId)) return redirect(res, '/?buffer=failed');
      let callbackStage = 'token exchange';
      try {
        const params = { grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: redirectUri, client_id: env.BUFFER_CLIENT_ID, code_verifier: transaction.verifier };
        if (env.BUFFER_CLIENT_SECRET) params.client_secret = env.BUFFER_CLIENT_SECRET;
        const tokens = await tokenRequest(params);
        if (!tokens.access_token) throw new Error('Buffer returned no access token.');
        if (!tokens.refresh_token) throw new Error('Buffer returned no refresh token; check that offline_access is enabled for the Buffer client.');
        callbackStage = 'saving connection';
        await store.saveConnection(s.userId, { ...tokens, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000 });
        return redirect(res, '/?buffer=connected');
      } catch (error) { console.error(`Buffer OAuth failed during ${callbackStage}: ${error.message}`); return redirect(res, '/?buffer=failed'); }
    }
    if (req.method === 'POST' && path === '/api/buffer/disconnect') { await store.deleteConnection(s.userId); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && path === '/api/buffer/channels') {
      const result = await buffer(s, 'query { account { organizations { id name } } }');
      const organizations = result.account?.organizations || [];
      const channels = [];
      for (const org of organizations) {
        const data = await buffer(s, 'query ($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name service } }', { organizationId: org.id });
        channels.push(...(data.channels || []).map(channel => ({ ...channel, organization: org.name })));
      }
      return json(res, 200, { channels });
    }
    if (req.method === 'GET' && path === '/api/github/repositories') {
      const login = String(s.email || '');
      if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login)) throw new Error('GitHub account name is unavailable. Sign in again or enter a repository manually.');
      const rawPage = url.searchParams.get('page') || '1';
      if (!/^[1-9]\d{0,2}$/.test(rawPage) || Number(rawPage) > 100) throw new Error('Invalid repository page.');
      const repositories = await github(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&direction=desc&per_page=100&page=${rawPage}`);
      if (!Array.isArray(repositories)) throw new Error('GitHub returned an invalid repository list.');
      const items = repositories.filter(repo => repo.private === false && repo.owner?.login?.toLowerCase() === login.toLowerCase() && typeof repo.full_name === 'string').map(repo => ({ fullName: repo.full_name, description: repo.description, updatedAt: repo.pushed_at }));
      return json(res, 200, { repositories: items, hasMore: repositories.length === 100, page: Number(rawPage) });
    }
    if (req.method === 'GET' && path === '/api/github/changes') {
      const { owner, repo } = parseRepo(url.searchParams.get('repo'));
      const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const repository = await github(prefix);
      if (repository.private) throw new Error('Only public repositories are supported.');
      const pulls = await github(`${prefix}/pulls?state=closed&sort=updated&direction=desc&per_page=100`);
      const changes = pulls.filter(pr => pr.merged_at).slice(0, 20).map(pr => ({ type: 'pr', number: pr.number, title: pr.title, url: pr.html_url, date: pr.merged_at }));
      let commits = [];
      if (repository.size !== 0) {
        const results = await github(`${prefix}/commits?per_page=20`);
        commits = results.filter(item => /^[a-f0-9]{40}$/i.test(item.sha || '') && item.commit?.message).map(item => ({ type: 'commit', sha: item.sha, title: item.commit.message.split(/\r?\n/)[0], url: item.html_url, date: item.commit.committer?.date || item.commit.author?.date }));
      }
      return json(res, 200, { repository: { fullName: repository.full_name, description: repository.description, url: repository.html_url }, changes, commits });
    }
    if (req.method === 'POST' && path === '/api/draft') {
      const input = await body(req), { owner, repo } = parseRepo(input.repo);
      const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const repository = await github(prefix);
      if (repository.private) throw new Error('Only public repositories are supported.');
      let change, evidenceType, warning;
      if (input.type === 'commit') {
        if (typeof input.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(input.sha)) throw new Error('Select a valid commit.');
        const commit = await github(`${prefix}/commits/${input.sha}`);
        if (!commit.commit?.message || !/^[a-f0-9]{40}$/i.test(commit.sha || '')) throw new Error('Commit details are unavailable.');
        change = { type: 'commit', sha: commit.sha, title: commit.commit.message.split(/\r?\n/)[0], url: commit.html_url };
        evidenceType = 'Commit message';
        warning = 'A commit records a code change. It does not confirm that the change is released or live.';
      } else if (!input.type || input.type === 'pr') {
        const number = Number(input.number);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error('Select a valid pull request.');
        const pr = await github(`${prefix}/pulls/${number}`);
        if (!pr.merged_at) throw new Error('Select a merged pull request.');
        change = { type: 'pr', title: pr.title, url: pr.html_url, number: pr.number, mergedAt: pr.merged_at };
        evidenceType = 'Pull request title';
        warning = 'Merged means the code was integrated. It does not confirm the change is released or live.';
      } else throw new Error('Select a valid change.');
      const options = createDraftOptions(change);
      return json(res, 200, { draft: options[0].text, options, change, evidence: [{ text: change.title, url: change.url, type: evidenceType }], warning });
    }
    if (req.method === 'POST' && path === '/api/buffer/queue') {
      const input = await body(req);
      if (!input.text || typeof input.text !== 'string' || input.text.length > 10000 || !input.text.trim()) throw new Error('Enter a post between 1 and 10,000 characters.');
      if (typeof input.channelId !== 'string' || !input.channelId || input.channelId.length > 200) throw new Error('Select a connected Buffer channel.');
      if (typeof input.key !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(input.key)) throw new Error('Invalid submission identifier.');
      const key = `${s.userId}:${input.key}`;
      const claim = await store.query('INSERT INTO submissions (idempotency_key, user_id, status_code, result_json, created_at) VALUES (?, ?, 409, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING RETURNING idempotency_key', [key, s.userId, JSON.stringify({ error: 'This submission is already processing or its outcome is unknown. Check Buffer before retrying.' }), Date.now()]);
      if (!claim.results.length) { const prior = await store.query('SELECT status_code, result_json FROM submissions WHERE idempotency_key = ? AND user_id = ?', [key, s.userId]); if (!prior.results.length) throw new Error('Submission is unavailable.'); return json(res, prior.results[0].status_code, JSON.parse(prior.results[0].result_json)); }
      const saveSubmission = async (status, result) => store.query('UPDATE submissions SET status_code = ?, result_json = ? WHERE idempotency_key = ? AND user_id = ?', [status, JSON.stringify(result), key, s.userId]);
      try {
        const data = await buffer(s, 'mutation ($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id text dueAt } } ... on MutationError { message } } }', { input: { text: input.text, channelId: input.channelId, schedulingType: 'automatic', mode: 'addToQueue' } });
        if (!data.createPost?.post?.id && !data.createPost?.message) throw new Error('Buffer did not return a post ID or rejection.');
        if (!data.createPost?.post?.id) { const result = { error: data.createPost.message, code: 'buffer_rejected' }; await saveSubmission(400, result); return json(res, 400, result); }
        const result = { post: data.createPost.post }; await saveSubmission(200, result); return json(res, 200, result);
      } catch (error) { return json(res, 502, { error: `${error.message} The outcome may be unknown; check Buffer before retrying.` }); }
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { return json(res, 400, { error: error.message || 'Something went wrong.' }); }
};
const req = { method: request.method, url: request.url, headers: Object.fromEntries(request.headers), async *[Symbol.asyncIterator]() {
  if (!request.body) return;
  const reader = request.body.getReader(); let size = 0;
  while (true) { const {value, done} = await reader.read(); if (done) break; size += value.byteLength; if (size > 20000) { await reader.cancel(); throw new Error('Request too large.'); } yield Buffer.from(value); }
} };
let status = 200, resultBody = '', headers = new Headers();
const res = { setHeader(name, value) { headers.set(name, value); }, writeHead(code, values) { status = code; for (const [name,value] of Object.entries(values || {})) headers.set(name,value); }, end(value = '') { resultBody = value; } };
await handle(req, res);
return new Response(resultBody, { status, headers });
}
export default { fetch: handleRequest };
