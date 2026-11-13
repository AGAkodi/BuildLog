import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export function randomToken() { return randomBytes(32).toString('base64url'); }
export function challenge(verifier) { return createHash('sha256').update(verifier).digest('base64url'); }
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function parseRepo(input) {
  let value = String(input || '').trim();
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Enter a valid GitHub repository URL.'); }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) throw new Error('Use a public github.com repository URL.');
    value = url.pathname.replace(/^\/+|\/+$/g, '');
  }
  value = value.replace(/\.git$/, '');
  const match = /^([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]{1,100})$/i.exec(value);
  if (!match || match[2] === '.' || match[2] === '..') throw new Error('Enter a repository as owner/name or a GitHub URL.');
  return { owner: match[1], repo: match[2] };
}
export function createDraftOptions(change) {
  const title = String(change.title || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('This change has no title to use as evidence.');
  const source = String(change.url || '');
  const label = change.type === 'commit' ? 'Recent commit' : 'Just merged';
  return [
    { label: 'Straightforward', text: `${label}: ${title}\n\n${source}` },
    { label: 'Build in public', text: `A look at the work in progress:\n\n${title}\n\n${source}` },
    { label: 'Progress note', text: `A small update from the project:\n\n${title}\n\nMore context: ${source}` }
  ];
}
export function createDraft(change) { return createDraftOptions(change)[0].text; }
export function isAllowedOrigin(requestOrigin, appUrl) {
  try { return !!requestOrigin && new URL(requestOrigin).origin === new URL(appUrl).origin; } catch { return false; }
}
