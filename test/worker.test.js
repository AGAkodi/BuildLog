import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker.js';

function envFor(db) {
  return { APP_URL: 'https://buildlog.example', BUFFER_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), DB: { async batch(statements) { db.exec('BEGIN'); try { const result = []; for (const statement of statements) result.push(await statement.all()); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }, prepare(sql) { return { bind(...params) { return { async all() { const stmt = db.prepare(sql); return { results: /^(SELECT|.*\bRETURNING\b)/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []), success: true }; } }; } }; } } };
}
test('Worker serves landing, protects API and checks mutation origin', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(await readFile(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8'));
  try {
    const env = envFor(db);
    const page = await worker.fetch(new Request('https://buildlog.example/'), env);
    assert.equal(page.status, 200); assert.match(await page.text(), /Your work has a story/);
    const status = await worker.fetch(new Request('https://buildlog.example/api/status'), env);
    assert.equal((await status.json()).authenticated, false);
    const protectedRoute = await worker.fetch(new Request('https://buildlog.example/api/buffer/channels'), env);
    assert.match((await protectedRoute.json()).error, /Sign in/);
    const csrf = await worker.fetch(new Request('https://buildlog.example/api/auth/signout', {method:'POST', headers:{Origin:'https://evil.example'}}), env);
    assert.equal(csrf.status, 403);
  } finally { db.close(); }
});

test('Worker completes OAuth, evidence selection and durable queue replay', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(await readFile(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8'));
  const env = envFor(db); Object.assign(env, { GITHUB_CLIENT_ID:'github-client', GITHUB_CLIENT_SECRET:'github-secret', BUFFER_CLIENT_ID:'buffer-client', BUFFER_CLIENT_SECRET:'buffer-secret' });
  const originalFetch = globalThis.fetch; let creates = 0;
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.includes('github.com/login/oauth/access_token')) return Response.json({ access_token:'github-access' });
    if (address === 'https://api.github.com/user') return Response.json({ id:42, login:'builder' });
    if (address === 'https://api.github.com/repos/acme/project') return Response.json({full_name:'acme/project',private:false,size:20});
    if (address.startsWith('https://api.github.com/repos/acme/project/pulls?')) return Response.json([{number:7,title:'Add activity feed',html_url:'https://github.com/acme/project/pull/7',merged_at:'2026-11-10T00:00:00Z'}]);
    if (address === 'https://api.github.com/repos/acme/project/commits?per_page=20') return Response.json([{sha:'a'.repeat(40),html_url:'https://github.com/acme/project/commit/'+ 'a'.repeat(40),commit:{message:'Fix parser\n\nMore detail',committer:{date:'2026-11-11T00:00:00Z'}}}]);
    if (address === 'https://api.github.com/repos/acme/project/commits/'+'a'.repeat(40)) return Response.json({sha:'a'.repeat(40),html_url:'https://github.com/acme/project/commit/'+ 'a'.repeat(40),commit:{message:'Fix parser\n\nMore detail'}});
    if (address.startsWith('https://api.github.com/users/builder/repos?')) return Response.json([{full_name:'builder/public-app',private:false,owner:{login:'builder'}},{full_name:'builder/private-app',private:true,owner:{login:'builder'}},{full_name:'other/public',private:false,owner:{login:'other'}}]);
    if (address === 'https://auth.buffer.com/token') return Response.json({ access_token:'buffer-access',refresh_token:'buffer-refresh',expires_in:3600 });
    if (address.includes('/repos/acme/project/pulls/7')) return Response.json({number:7,title:'Add activity feed',html_url:'https://github.com/acme/project/pull/7',merged_at:'2026-11-10T00:00:00Z'});
    if (address === 'https://api.buffer.com') { const request = JSON.parse(options.body); if (request.query.includes('createPost')) { creates++; return Response.json({data:{createPost:{post:{id:'post-42',text:request.variables.input.text,dueAt:null}}}}); } }
    throw new Error(`Unexpected request ${address}`);
  };
  try {
    let response = await worker.fetch(new Request('https://buildlog.example/api/auth/github/start'),env);
    assert.equal(response.status,303); const loginCookie=response.headers.get('set-cookie').split(';')[0]; const state=new URL(response.headers.get('location')).searchParams.get('state');
    response=await worker.fetch(new Request(`https://buildlog.example/api/auth/github/callback?state=${state}&code=test`,{headers:{cookie:loginCookie}}),env);
    assert.equal(response.headers.get('location'),'/?auth=connected'); const cookie=response.headers.get('set-cookie').split(';')[0];
    response=await worker.fetch(new Request('https://buildlog.example/api/github/repositories',{headers:{cookie}}),env);
    const repos=await response.json(); assert.deepEqual(repos.repositories.map(r=>r.fullName), ['builder/public-app']);
    response=await worker.fetch(new Request('https://buildlog.example/api/buffer/start',{headers:{cookie}}),env);
    const bufferState=new URL(response.headers.get('location')).searchParams.get('state');
    response=await worker.fetch(new Request(`https://buildlog.example/api/buffer/callback?state=${bufferState}&code=test`,{headers:{cookie}}),env);
    assert.equal(response.headers.get('location'),'/?buffer=connected');
    const headers={cookie,origin:'https://buildlog.example','content-type':'application/json'};
    response=await worker.fetch(new Request('https://buildlog.example/api/github/changes?repo=acme/project',{headers:{cookie}}),env);
    const changes=await response.json(); assert.equal(changes.changes[0].type,'pr'); assert.equal(changes.commits[0].title,'Fix parser');
    response=await worker.fetch(new Request('https://buildlog.example/api/draft',{method:'POST',headers,body:JSON.stringify({repo:'acme/project',type:'commit',sha:'a'.repeat(40)})}),env);
    const commitDraft=await response.json(); assert.equal(commitDraft.options.length,3); assert.match(commitDraft.draft,/Recent commit: Fix parser/); assert.doesNotMatch(commitDraft.draft,/merged|live/i); assert.equal(commitDraft.evidence[0].type,'Commit message');
    response=await worker.fetch(new Request('https://buildlog.example/api/draft',{method:'POST',headers,body:JSON.stringify({repo:'acme/project',number:7})}),env);
    const draft=await response.json(); assert.match(draft.draft,/Just merged: Add activity feed/);
    const request=()=>new Request('https://buildlog.example/api/buffer/queue',{method:'POST',headers,body:JSON.stringify({text:draft.draft,channelId:'channel-1',key:'12345678-1234-1234-1234-123456789012'})});
    response=await worker.fetch(request(),env); assert.equal((await response.json()).post.id,'post-42');
    response=await worker.fetch(request(),env); assert.equal((await response.json()).post.id,'post-42'); assert.equal(creates,1);
    db.prepare('INSERT INTO sessions (id_hash,user_id,email,expires_at) VALUES (?,?,?,?)').run('other-session','github:99','other',Date.now()+100000);
    db.prepare('INSERT INTO buffer_connections (user_id,encrypted_tokens,updated_at) VALUES (?,?,?)').run('github:99','other-encrypted',Date.now());
    response=await worker.fetch(new Request('https://buildlog.example/api/account/delete',{method:'POST',headers}),env);
    assert.equal(response.status,200); assert.equal((await response.json()).ok,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get('github:42').n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM buffer_connections WHERE user_id=?').get('github:42').n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE user_id=?').get('github:42').n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get('github:99').n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM buffer_connections WHERE user_id=?').get('github:99').n,1);
    response=await worker.fetch(new Request('https://buildlog.example/api/status',{headers:{cookie}}),env);
    assert.equal((await response.json()).authenticated,false);
  } finally { globalThis.fetch=originalFetch; db.close(); }
});
