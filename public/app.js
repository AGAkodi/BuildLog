const $ = id => document.getElementById(id);
let currentRepo = '', submissionKey = crypto.randomUUID();
let authenticated = false;
let rejectedSubmissionText = null;
let repoPage = 0;
let draftOptions = [], selectedDraft = '';
const showMessage = (id, text, kind = 'error') => { const el = $(id); el.textContent = text; el.className = `message ${kind}`; el.hidden = !text; };
async function api(url, options) { const response = await fetch(url, options); const result = await response.json(); if (!response.ok) { const error = new Error(result.error || 'Something went wrong.'); error.code = result.code; throw error; } return result; }
function busy(button, active, label) { if (active) { button.dataset.label = button.innerHTML; button.disabled = true; button.textContent = label; } else { button.disabled = false; button.innerHTML = button.dataset.label; } }
async function loadRepositories() {
  const select = $('repo-select'), more = $('repo-more'), help = $('repo-picker-help');
  more.disabled = true;
  try {
    const data = await api(`/api/github/repositories?page=${repoPage + 1}`);
    if (!repoPage) { select.replaceChildren(); const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Select a public repository'; select.append(placeholder); }
    for (const repo of data.repositories) { const option = document.createElement('option'); option.value = repo.fullName; option.textContent = repo.fullName; select.append(option); }
    repoPage = data.page; select.disabled = select.options.length <= 1; more.hidden = !data.hasMore;
    help.textContent = select.disabled ? 'No public repositories found. You can enter another repository below.' : 'Select a repository to load its recent changes.';
  } catch (error) {
    if (!repoPage) { select.replaceChildren(); const placeholder = document.createElement('option'); placeholder.textContent = 'Repositories unavailable'; select.append(placeholder); select.disabled = true; }
    help.textContent = `${error.message} You can still enter a repository below.`;
  } finally { more.disabled = false; }
}
$('repo-select').addEventListener('change', () => { if (!$('repo-select').value) return; $('repo').value = $('repo-select').value; $('repo-form').requestSubmit(); });
$('repo-more').addEventListener('click', loadRepositories);
$('repo-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); busy(button, true, 'Looking for changes…'); showMessage('repo-error', ''); $('changes').hidden = true;
  try {
    currentRepo = $('repo').value.trim(); const data = await api(`/api/github/changes?repo=${encodeURIComponent(currentRepo)}`);
    $('repo-name').textContent = data.repository.fullName; $('change-list').replaceChildren(); $('changes').hidden = false;
    const sources = [...data.changes, ...(data.commits || [])]; $('empty').hidden = !!sources.length;
    for (const change of sources) {
      const row = document.createElement('div'); row.className = 'change-row';
      const icon = document.createElement('span'); icon.className = 'pr-icon'; icon.textContent = change.type === 'commit' ? '●' : '⑂';
      const detail = document.createElement('div'); detail.className = 'change-detail';
      const link = document.createElement('a'); link.href = change.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = change.title;
      const meta = document.createElement('small'); const date = change.date ? new Date(change.date).toLocaleDateString() : 'date unavailable';
      meta.textContent = change.type === 'commit' ? `Commit ${change.sha.slice(0, 7)} · ${date}` : `PR #${change.number} · merged ${date}`; detail.append(link, meta);
      const button = document.createElement('button'); button.className = 'select-button'; button.textContent = 'Create draft ↗'; button.addEventListener('click', () => generate(change, button));
      row.append(icon, detail, button); $('change-list').append(row);
    }
  } catch (error) { showMessage('repo-error', error.message); } finally { busy(button, false); }
});
async function generate(change, button) {
  busy(button, true, 'Creating…'); showMessage('repo-error', '');
  try {
    const data = await api('/api/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: currentRepo, type: change.type, number: change.number, sha: change.sha }) });
    draftOptions = data.options; selectedDraft = data.draft; $('draft').value = selectedDraft; renderOptions(); $('source-status').textContent = data.change.type === 'commit' ? 'COMMIT' : 'MERGED'; $('evidence-link').href = data.change.url; $('evidence-link').textContent = `${data.change.type === 'commit' ? data.change.sha.slice(0, 7) : '#' + data.change.number}  ${data.change.title} ↗`; $('warning').textContent = data.warning;
    $('studio-empty').hidden = true; $('draft-area').hidden = false; submissionKey = crypto.randomUUID(); rejectedSubmissionText = null; updateCount(); showMessage('publish-message', ''); $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showMessage('repo-error', error.message); } finally { busy(button, false); }
}
function renderOptions() {
  const container = $('draft-options'); container.replaceChildren();
  draftOptions.forEach(option => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'draft-option'; button.textContent = option.label; button.setAttribute('aria-pressed', String(option.text === selectedDraft));
    button.addEventListener('click', () => {
      if ($('draft').value !== selectedDraft && !window.confirm('Replace your edited draft with this option?')) return;
      if (rejectedSubmissionText !== null && option.text !== rejectedSubmissionText) { submissionKey = crypto.randomUUID(); rejectedSubmissionText = null; }
      selectedDraft = option.text; $('draft').value = option.text; renderOptions(); updateCount();
    });
    container.append(button);
  });
}
function updateCount() { $('count').textContent = `${$('draft').value.length} characters`; }
$('draft').addEventListener('input', () => { updateCount(); if (rejectedSubmissionText !== null && $('draft').value !== rejectedSubmissionText) { submissionKey = crypto.randomUUID(); rejectedSubmissionText = null; } });
$('connect').addEventListener('click', () => {
  sessionStorage.setItem('buildlog_pending_draft', JSON.stringify({ repo: currentRepo, draft: $('draft').value, evidenceUrl: $('evidence-link').href, evidenceText: $('evidence-link').textContent, warning: $('warning').textContent, options: draftOptions, selectedDraft, status: $('source-status').textContent }));
  window.location.href = '/api/buffer/start';
});
function restoreDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('buildlog_pending_draft') || 'null');
    if (!saved || !saved.repo || !saved.evidenceUrl) return;
    const source = new URL(saved.evidenceUrl);
    if (source.protocol !== 'https:' || source.hostname !== 'github.com') return;
    currentRepo = saved.repo; $('repo').value = saved.repo; $('draft').value = saved.draft || '';
    $('evidence-link').href = source.href; $('evidence-link').textContent = saved.evidenceText || 'View pull request ↗'; $('warning').textContent = saved.warning || ''; draftOptions = Array.isArray(saved.options) ? saved.options : []; selectedDraft = saved.selectedDraft || saved.draft || ''; $('source-status').textContent = saved.status === 'COMMIT' ? 'COMMIT' : 'MERGED'; renderOptions();
    $('studio-empty').hidden = true; $('draft-area').hidden = false; updateCount();
    sessionStorage.removeItem('buildlog_pending_draft');
  } catch { sessionStorage.removeItem('buildlog_pending_draft'); }
}
restoreDraft();
$('delete-account').addEventListener('click', async () => {
  if (!window.confirm('Delete your BuildLog account data? This removes your saved Buffer connection, sessions, and submission records. Posts in Buffer will remain. This cannot be undone.')) return;
  const button = $('delete-account'); busy(button, true, 'Deleting…'); showMessage('account-message', '');
  try { await api('/api/account/delete', { method: 'POST' }); sessionStorage.removeItem('buildlog_pending_draft'); location.href = '/?account=deleted'; }
  catch (error) { showMessage('account-message', error.message); busy(button, false); }
});
$('signout').addEventListener('click', async () => {
  try { await api('/api/auth/signout', { method: 'POST' }); sessionStorage.removeItem('buildlog_pending_draft'); location.href = '/'; }
  catch (error) { showMessage('repo-error', error.message); }
});
$('disconnect').addEventListener('click', async () => {
  try { await api('/api/buffer/disconnect', { method: 'POST' }); $('channel-area').hidden = true; $('disconnect').hidden = true; $('connect').disabled = false; $('connect').textContent = 'Connect Buffer ↗'; showMessage('publish-message', 'Buffer disconnected.', 'success'); }
  catch (error) { showMessage('publish-message', error.message); }
});
async function loadStatus() {
  const params = new URLSearchParams(location.search); if (params.get('account') === 'deleted') showMessage('auth-message', 'Your BuildLog account data was deleted.', 'success'); if (params.get('auth') === 'failed') showMessage('auth-message', 'GitHub sign-in was not completed. Please try again.'); if (params.get('buffer') === 'failed') showMessage('repo-error', 'Buffer connection was not completed. Please try again.');
  if (params.has('buffer') || params.has('auth') || params.has('account')) history.replaceState(null, '', '/');
  try {
    const status = await api('/api/status');
    authenticated = status.authenticated; $('auth-panel').hidden = authenticated; $('workspace').hidden = !authenticated; $('landing').hidden = authenticated; $('nav-start').hidden = authenticated; $('signout').hidden = !authenticated; document.body.classList.toggle('signed-in', authenticated);
    if (!authenticated) return;
    loadRepositories();
    if (status.reconnect) { $('connect').textContent = 'Reconnect Buffer ↗'; $('disconnect').hidden = false; }
    if (!status.configured) { $('connect').textContent = 'Buffer setup required'; $('connect').disabled = true; return; }
    if (!status.connected) return;
    $('connect').textContent = 'Buffer connected ✓'; $('connect').disabled = true; $('disconnect').hidden = false;
    const data = await api('/api/buffer/channels'); $('channel-area').hidden = false;
    for (const channel of data.channels) { const option = document.createElement('option'); option.value = channel.id; option.textContent = `${channel.name} · ${channel.service} (${channel.organization})`; $('channel').append(option); }
    if (!data.channels.length) showMessage('publish-message', 'No channels found. Connect a supported channel in Buffer first.');
  } catch (error) { showMessage(authenticated ? 'publish-message' : 'auth-message', error.message); }
}
$('queue').addEventListener('click', async () => {
  const button = $('queue'); if (!$('channel').value) return showMessage('publish-message', 'Choose a Buffer channel first.');
  busy(button, true, 'Queueing…'); showMessage('publish-message', '');
  try {
    const result = await api('/api/buffer/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('draft').value, channelId: $('channel').value, key: submissionKey }) });
    showMessage('publish-message', `Queued in Buffer. Post ID: ${result.post.id}. Open Buffer to verify your post.`, 'success'); button.disabled = true; button.textContent = 'Queued ✓';
  } catch (error) { if (error.code === 'buffer_rejected') rejectedSubmissionText = $('draft').value; showMessage('publish-message', error.message); busy(button, false); }
});
loadStatus();
