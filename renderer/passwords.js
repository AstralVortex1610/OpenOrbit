// Orbit — Passwords screen.
(function () {
  const api = window.orbit;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const A = () => window.OrbitApp;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let rows = []; let editing = null; const shown = {};

  async function load() { rows = await api.passwords.list(); render(); }

  function render() {
    const q = ($('#pwSearch').value || '').toLowerCase().trim();
    const list = rows.filter(r => !q || r.site.includes(q) || String(r.username || '').toLowerCase().includes(q)).sort((a, b) => a.site.localeCompare(b.site));
    $('#pwList').innerHTML = list.length ? list.map((r, i) => `<div class="cx-row pw-row" data-id="${esc(r.id)}" style="--d:${i * 35}ms">
      <div class="pw-ico">${esc(r.site[0] || '?').toUpperCase()}</div>
      <div class="cx-t"><b>${esc(r.site)}</b><small>${esc(r.username || 'no username')}${r.note ? ' · ' + esc(r.note) : ''}</small></div>
      <code class="pw-dots" data-pw>${shown[r.id] ? esc(shown[r.id]) : (r.hasPassword ? '••••••••' : '<i class="muted">no password</i>')}</code>
      ${r.hasPassword ? `<button class="link-btn" data-show>${shown[r.id] ? 'Hide' : 'Show'}</button><button class="link-btn" data-copy>Copy</button>` : ''}
      <button class="link-btn" data-edit>Edit</button><button class="link-btn danger" data-del>Delete</button></div>`).join('')
      : `<div class="empty-note">${rows.length ? 'Nothing matches.' : 'No logins yet. Tell Orbit one in chat, like "save my GitHub login: user affan, password …", or add it here.'}</div>`;
    $$('.pw-row').forEach(row => {
      const id = row.dataset.id; const r = rows.find(x => x.id === id);
      const show = $('[data-show]', row), copy = $('[data-copy]', row);
      if (show) show.onclick = async () => { if (shown[id]) delete shown[id]; else shown[id] = await api.passwords.reveal(id); render(); setTimeout(() => { if (shown[id]) { delete shown[id]; render(); } }, 20000); };
      if (copy) copy.onclick = async () => { const p = await api.passwords.reveal(id); await navigator.clipboard.writeText(p); A().toast(`Copied the ${r.site} password`); };
      $('[data-edit]', row).onclick = () => openForm(r);
      $('[data-del]', row).onclick = async () => { if (!confirm(`Delete the ${r.site} login${r.username ? ` for ${r.username}` : ''}?`)) return; await api.passwords.remove(id); A().toast('Login deleted'); load(); };
    });
  }

  function openForm(r) {
    editing = r ? r.id : null;
    $('#pwFormTitle').textContent = r ? `Edit ${r.site}` : 'Add a login';
    $('#pwSite').value = r ? r.site : ''; $('#pwUser').value = r ? r.username || '' : ''; $('#pwPass').value = '';
    $('#pwUrl').value = r ? r.url || '' : ''; $('#pwNote').value = r ? r.note || '' : '';
    $('#pwPassHint').textContent = r && r.hasPassword ? 'leave empty to keep the saved one' : '';
    $('#pwForm').hidden = false; $('#pwSite').focus();
  }

  $('#pwAdd').onclick = () => openForm(null);
  $('#pwCancel').onclick = () => { $('#pwForm').hidden = true; };
  $('#pwSearch').oninput = render;
  $('#pwSave').onclick = async () => {
    const l = { id: editing || undefined, site: $('#pwSite').value.trim(), username: $('#pwUser').value.trim(), password: $('#pwPass').value, url: $('#pwUrl').value.trim(), note: $('#pwNote').value.trim() };
    if (!l.site) return A().toast('Add the website first');
    try { await api.passwords.save(l); $('#pwForm').hidden = true; A().toast(editing ? 'Login updated' : 'Login saved'); load(); }
    catch (e) { A().toast(String(e.message || e).replace(/^Error invoking remote method[^:]*: (Error: )?/, '')); }
  };

  window.addEventListener('orbit-view', (e) => { if (e.detail.view === 'passwords') load(); });
  api.on('agent:event', (e) => { if (e && e.type === 'passwords_changed' && $('#view-passwords.active, #view-passwords.show')) load(); });
})();
