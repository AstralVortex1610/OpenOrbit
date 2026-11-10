// Orbit — Home (panels), Projects and Updates screens.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const api = window.orbit;
  const A = () => window.OrbitApp;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const I = {
    refresh: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4.5 19.5h4l10-10-4-4-10 10zM13 7l4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M10 11v6M14 11v6M6 7l1 12.5h10L18 7M9 7V4.5h6V7"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="M14.5 6 8.5 12l6 6"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    ext: '<svg viewBox="0 0 24 24"><path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M7 3.5h7l4.5 4.5v12.5H7zM14 3.5V8h4.5"/></svg>',
    kind: {
      task: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
      worker: '<svg viewBox="0 0 24 24"><path d="M4 7h10M4 12h16M4 17h7"/><circle cx="18" cy="7" r="2"/></svg>',
      project: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
      chat: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/></svg>',
      panel: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
      notice: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
    },
  };
  const KIND_NAME = { task: 'Scheduled', worker: 'Background task', project: 'Project', chat: 'Chat', panel: 'Panel', notice: 'Notice' };

  function ago(t) {
    if (!t) return 'never';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  const plain = (t, n = 160) => { const s = String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const EVERY = [[30, 'Every 30 min'], [60, 'Every hour'], [180, 'Every 3 hours'], [360, 'Every 6 hours'], [720, 'Twice a day'], [1440, 'Once a day'], [10080, 'Once a week'], [0, 'Only when I refresh']];
  const everyText = (m) => (EVERY.find(([v]) => v === m) || [0, m ? `Every ${m} min` : 'Manual'])[1];

  // ---------- modal ----------
  let modalDone = null;
  function modal({ title, sub, body, ok = 'Save', onOpen }) {
    return new Promise((resolve) => {
      $('#modalTitle').textContent = title; $('#modalSub').textContent = sub || ''; $('#modalSub').style.display = sub ? '' : 'none';
      $('#modalBody').innerHTML = body; $('#modalOk').textContent = ok;
      $('#modal').classList.add('open'); $('#modal').setAttribute('aria-hidden', 'false');
      modalDone = (v) => { $('#modal').classList.remove('open'); $('#modal').setAttribute('aria-hidden', 'true'); modalDone = null; resolve(v); };
      if (onOpen) onOpen($('#modalBody'));
      setTimeout(() => { const f = $('#modalBody input, #modalBody textarea'); if (f) f.focus(); }, 60);
    });
  }
  $('#modalForm').addEventListener('submit', (e) => {
    e.preventDefault(); if (!modalDone) return;
    const out = {}; $$('#modalBody [name]').forEach(f => (out[f.name] = f.value)); modalDone(out);
  });
  $('#modalCancel').onclick = () => modalDone && modalDone(null);
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal' && modalDone) modalDone(null); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalDone) modalDone(null); });

  // ---------- HOME ----------
  const SUGGEST = [
    { t: 'Weather', p: 'Current weather and today\'s high/low where I live (check memory for my city; ask in sub if unknown)', e: 180 },
    { t: 'GitHub trending AI', p: 'Top 5 trending AI / LLM repositories on GitHub today, with stars gained today', e: 720 },
    { t: 'AI news', p: 'The 4 biggest AI model and lab news stories from the last 24 hours, with links', e: 360 },
    { t: 'Unread mail', p: 'Number of unread emails in my Gmail inbox and the 4 most important senders/subjects', e: 60 },
  ];
  function greet() {
    const s = A() ? A().settings : {};
    const h = new Date().getHours();
    const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    $('#homeGreeting').textContent = s && s.userName ? `${part}, ${s.userName}.` : `${part}.`;
    $('#homeDate').textContent = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  async function pulse() {
    const s = await api.homeSummary();
    const bits = [];
    if (s.busy) bits.push('<span class="live-dot"></span>Working on something now');
    if (s.workers) bits.push(`${s.workers} background task${s.workers > 1 ? 's' : ''} running`);
    bits.push(s.tasks ? `${s.tasks} scheduled task${s.tasks === 1 ? '' : 's'} on` : 'No scheduled tasks on');
    if (s.unread) bits.push(`<button class="link" data-goto="updates">${s.unread} new update${s.unread > 1 ? 's' : ''}</button>`);
    $('#homePulse').innerHTML = bits.join('<i>·</i>');
    wireGoto($('#homePulse'));
    badge(s.unread);
  }
  function badge(n) { const b = $('#updBadge'); b.textContent = n > 9 ? '9+' : n || ''; b.classList.toggle('on', n > 0); }

  function panelBody(p) {
    const d = p.data;
    if (!d) {
      if (p.status === 'error') return `<div class="pn-err">${esc(p.error || 'Couldn\'t fill this panel.')}</div><button class="ghost sm" data-act="refresh">Try again</button>`;
      return '<div class="pn-skel"><i></i><i></i><i></i></div><div class="pn-wait">Orbit is gathering real values…</div>';
    }
    const trend = d.trend === 'up' ? 'up' : d.trend === 'down' ? 'down' : '';
    if (d.kind === 'stat') return `<div class="pn-value">${esc(d.value)}${d.unit ? `<small>${esc(d.unit)}</small>` : ''}</div>${d.delta ? `<div class="pn-delta ${trend}">${trend === 'up' ? '▲ ' : trend === 'down' ? '▼ ' : ''}${esc(d.delta)}</div>` : ''}${d.sub ? `<div class="pn-sub">${esc(d.sub)}</div>` : ''}${d.items && d.items.length ? listHtml(d.items.slice(0, 3)) : ''}`;
    if (d.kind === 'progress') {
      const pct = Math.round((d.progress || 0) * 100);
      return `<div class="pn-prog"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" class="trk"/><circle cx="22" cy="22" r="18" class="bar" style="stroke-dasharray:${(113.1 * pct / 100).toFixed(1)} 113.1"/></svg><div><div class="pn-value">${esc(d.value || pct + '%')}${d.unit ? `<small>${esc(d.unit)}</small>` : ''}</div>${d.sub ? `<div class="pn-sub">${esc(d.sub)}</div>` : ''}</div></div>${d.delta ? `<div class="pn-delta ${trend}">${esc(d.delta)}</div>` : ''}`;
    }
    if (d.kind === 'list') return `${d.sub ? `<div class="pn-sub top">${esc(d.sub)}</div>` : ''}${listHtml(d.items)}`;
    return `<div class="pn-text">${esc(d.text || d.sub)}</div>`;
  }
  function listHtml(items) {
    return `<div class="pn-list">${(items || []).map((i, n) => `<${i.url ? `a href="${esc(i.url)}" target="_blank"` : 'div'} class="pn-row" style="animation-delay:${n * 45}ms"><span class="pn-l"><b>${esc(i.label)}</b>${i.sub ? `<span>${esc(i.sub)}</span>` : ''}</span>${i.value ? `<span class="pn-v">${esc(i.value)}</span>` : ''}</${i.url ? 'a' : 'div'}>`).join('')}</div>`;
  }
  async function renderPanels() {
    const panels = await api.panels.list();
    const el = $('#panels');
    if (!panels.length) {
      el.innerHTML = `<div class="panels-empty"><div class="pe-art" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div><h4>Your Home is empty</h4><p>Panels show things that change: prices, weather, a countdown, mail. Orbit fills them with real values and keeps them fresh.</p><div class="pe-chips">${SUGGEST.map((s, i) => `<button class="chip-sm" data-sug="${i}">${I.plus}${esc(s.t)}</button>`).join('')}</div></div></div>`;
      $$('[data-sug]', el).forEach(b => b.onclick = async () => { const s = SUGGEST[+b.dataset.sug]; await api.panels.create({ title: s.t, prompt: s.p, everyMinutes: s.e }); renderPanels(); });
      return;
    }
    el.innerHTML = panels.map((p, i) => {
      const d = p.data || {};
      const busy = p.status === 'building' || p.status === 'refreshing';
      return `<article class="panel kind-${d.kind || 'none'} ${busy ? 'busy' : ''} ${p.status === 'error' ? 'err' : ''}" data-id="${p.id}" style="animation-delay:${i * 50}ms">
        <header><h4>${esc(p.title)}</h4><span class="pn-state">${busy ? '<span class="spin"></span>' : p.status === 'error' && p.data ? '<span class="dot-err" title="Last refresh failed"></span>' : ''}</span>
          <div class="pn-menu"><button data-act="refresh" title="Refresh now">${I.refresh}</button><button data-act="edit" title="Edit">${I.edit}</button><button data-act="left" title="Move left">${I.left}</button><button data-act="right" title="Move right">${I.right}</button><button data-act="delete" title="Remove">${I.trash}</button></div></header>
        <div class="pn-body">${panelBody(p)}</div>
        <footer><span>${p.updatedAt && p.data ? `Updated ${ago(p.updatedAt)}` : busy ? 'Building…' : ''}${d.source ? ` · ${esc(d.source)}` : ''}</span>${d.link ? `<a href="${esc(d.link)}" target="_blank" title="Open">${I.ext}</a>` : `<span class="pn-every">${esc(everyText(p.everyMinutes))}</span>`}</footer>
      </article>`;
    }).join('') + `<button class="panel add" id="addPanelTile">${I.plus}<span>New panel</span><small>Ask for anything that changes</small></button>`;
    $('#addPanelTile').onclick = () => editPanel();
    $$('.panel[data-id]', el).forEach(card => {
      const id = card.dataset.id; const p = panels.find(x => x.id === id);
      $$('[data-act]', card).forEach(b => b.onclick = async (e) => {
        e.stopPropagation();
        const a = b.dataset.act;
        if (a === 'refresh') { await api.panels.refresh(id); renderPanels(); }
        if (a === 'edit') editPanel(p);
        if (a === 'left' || a === 'right') { await api.panels.move(id, a === 'left' ? -1 : 1); renderPanels(); }
        if (a === 'delete') { if (confirm(`Remove "${p.title}" from Home?`)) { await api.panels.remove(id); renderPanels(); } }
      });
    });
  }
  async function editPanel(p) {
    const v = await modal({
      title: p ? 'Edit panel' : 'New panel',
      sub: p ? '' : 'Say what it should show. Orbit finds the real values and keeps them fresh.',
      ok: p ? 'Save' : 'Add to Home',
      body: `<label>What should it show?<textarea name="prompt" rows="3" required placeholder="e.g. Bitcoin price in rupees with today's change · Days left until JEE Main · Top 5 GitHub trending AI repos">${esc(p ? p.prompt : '')}</textarea></label>
        <div class="row2"><label>Title<input name="title" placeholder="Orbit picks one" value="${esc(p ? p.title : '')}" /></label>
        <label>Refresh<select name="every">${EVERY.map(([m, t]) => `<option value="${m}" ${(p ? p.everyMinutes : 180) === m ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div>`,
    });
    if (!v || !v.prompt.trim()) return;
    if (p) await api.panels.update(p.id, { title: v.title.trim() || p.title, prompt: v.prompt.trim(), everyMinutes: Number(v.every) });
    else await api.panels.create({ title: v.title.trim(), prompt: v.prompt.trim(), everyMinutes: Number(v.every) });
    renderPanels();
  }
  $('#addPanelBtn').onclick = () => editPanel();
  $('#homeAsk').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#homeAskInput').value.trim(); if (!t) return;
    $('#homeAskInput').value = ''; A().send(t);
  });

  function feedItem(u, compact) {
    const k = I.kind[u.kind] ? u.kind : 'notice';
    return `<div class="upd ${u.read ? '' : 'unread'} ${compact ? 'compact' : ''}" data-id="${u.id}">
      <span class="upd-ico k-${k}">${I.kind[k]}</span>
      <div class="upd-main">
        <div class="upd-top"><b>${esc(u.title)}</b><span>${KIND_NAME[k] || ''} · ${ago(u.at)}</span></div>
        ${compact ? `<div class="upd-snip">${esc(plain(u.text, 110))}</div>` : `<div class="upd-text md">${A().md(u.text || '')}</div>`}
        ${!compact && u.target ? `<button class="link" data-open>Open ${u.target.project ? 'project' : u.target.view === 'home' ? 'Home' : 'chat'}</button>` : ''}
      </div>
      ${u.read ? '' : '<i class="upd-dot"></i>'}
    </div>`;
  }
  function openTarget(u) {
    if (!u || !u.target) return;
    if (u.target.project) A().show('chat', { scope: u.target.project });
    else if (u.target.view === 'home') A().show('home');
    else A().show('chat', { scope: 'main' });
  }
  async function renderHomeFeed() {
    const ups = (await api.updates.list()).slice(0, 4);
    const el = $('#homeUpdates');
    el.innerHTML = ups.length ? ups.map(u => feedItem(u, true)).join('') : '<div class="mini-empty">Nothing yet. When Orbit works on its own, it shows up here.</div>';
    $$('.upd', el).forEach(n => n.onclick = async () => { const u = ups.find(x => x.id === n.dataset.id); await api.updates.read([u.id]); if (u.target) openTarget(u); else A().show('updates'); });
  }
  async function renderHomeProjects() {
    const ps = (await api.projects.list()).slice(0, 3);
    const el = $('#homeProjects');
    el.innerHTML = ps.length ? ps.map(p => `<button class="mini-proj" data-id="${p.id}"><span class="proj-mono" style="--c:${p.color}">${esc(p.name.slice(0, 1).toUpperCase())}</span><span class="mp-main"><b>${esc(p.name)}</b><span>${p.busy ? '<span class="live-dot"></span>Working…' : esc(plain(p.last || p.about || 'No messages yet', 70))}</span></span><span class="mp-ago">${ago(p.updated)}</span></button>`).join('')
      : `<button class="mini-empty new" id="homeNewProj">${I.plus} Start your first project</button>`;
    $$('.mini-proj', el).forEach(b => b.onclick = () => A().show('chat', { scope: b.dataset.id }));
    const n = $('#homeNewProj'); if (n) n.onclick = newProject;
  }
  function renderHome() { greet(); pulse(); renderPanels(); renderHomeFeed(); renderHomeProjects(); }

  // ---------- PROJECTS ----------
  async function renderProjects() {
    const ps = await api.projects.list();
    const el = $('#projGrid');
    if (!ps.length) { el.innerHTML = `<div class="proj-none"><div class="pn-folder" aria-hidden="true"></div><h4>No projects yet</h4><p>Give a body of work its own space: an app you're building, an exam plan, a client.</p><button class="primary" id="projNoneBtn">${I.plus}New project</button></div>`; $('#projNoneBtn').onclick = newProject; return; }
    el.innerHTML = ps.map((p, i) => `<button class="proj-card" data-id="${p.id}" style="--c:${p.color};animation-delay:${i * 45}ms">
      <span class="pc-top"><span class="proj-mono" style="--c:${p.color}">${esc(p.name.slice(0, 1).toUpperCase())}</span>${p.busy ? '<span class="pc-busy"><span class="live-dot"></span>Working</span>' : ''}</span>
      <b>${esc(p.name)}</b>
      <span class="pc-about">${esc(p.about || 'No description')}</span>
      <span class="pc-last">${p.last ? esc(plain(p.last, 120)) : '<em>No messages yet</em>'}</span>
      <span class="pc-foot"><span>${p.files} file${p.files === 1 ? '' : 's'}</span><span>${ago(p.updated)}</span></span>
    </button>`).join('') + `<button class="proj-card add" id="projAddTile">${I.plus}<b>New project</b></button>`;
    $$('.proj-card[data-id]', el).forEach(b => b.onclick = () => A().show('chat', { scope: b.dataset.id }));
    $('#projAddTile').onclick = newProject;
  }
  async function newProject() {
    const v = await modal({ title: 'New project', sub: 'Its own chat, files folder and brief.', ok: 'Create', body: `<label>Name<input name="name" required maxlength="60" placeholder="e.g. RideCompare app" /></label><label>What's it for?<textarea name="about" rows="3" placeholder="One or two lines. Orbit uses this as the project's goal."></textarea></label>` });
    if (!v || !v.name.trim()) return;
    const p = await api.projects.create({ name: v.name.trim(), about: v.about.trim() });
    A().show('chat', { scope: p.id });
  }
  $('#newProjectBtn').onclick = newProject;

  // project chat header + drawer
  let cur = null;
  window.addEventListener('orbit-scope', (e) => { cur = e.detail; fillScope(); });
  function fillScope() {
    if (!cur) return;
    $('#scopeName').textContent = cur.name; $('#scopeAbout').textContent = cur.about || '';
    const m = $('#scopeMono'); m.textContent = cur.name.slice(0, 1).toUpperCase(); m.style.setProperty('--c', cur.color);
    $('#briefText').value = cur.brief || ''; $('#briefSave').disabled = true;
    $('#fileList').innerHTML = (cur.fileList || []).length ? cur.fileList.map(f => `<button class="file" data-n="${esc(f.name)}">${I.file}<span>${esc(f.name)}</span><small>${f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'}</small></button>`).join('') : '<div class="mini-empty">No files yet. Anything Orbit makes for this project lands here.</div>';
    $$('#fileList .file').forEach(b => b.onclick = () => api.projects.openFile(cur.id, b.dataset.n));
  }
  async function reloadCur() { if (!cur) return; const p = await api.projects.get(cur.id); if (p) { const dirty = !$('#briefSave').disabled; const keep = $('#briefText').value; cur = p; fillScope(); if (dirty) { $('#briefText').value = keep; $('#briefSave').disabled = false; } } }
  $('#scopeBack').onclick = () => A().show('projects');
  $('#drawerBtn').onclick = () => { $('#drawer').classList.toggle('open'); if ($('#drawer').classList.contains('open')) reloadCur(); };
  $('#briefText').addEventListener('input', () => ($('#briefSave').disabled = false));
  $('#briefSave').onclick = async () => { await api.projects.update(cur.id, { brief: $('#briefText').value }); $('#briefSave').disabled = true; A().toast('Brief saved'); };
  $('#openProjFolder').onclick = () => api.projects.openFolder(cur.id);
  $('#clearProjChat').onclick = async () => { if (!confirm(`Clear the chat in "${cur.name}"? The brief and files stay.`)) return; await api.projects.clear(cur.id); A().openScope(cur.id); };
  $('#deleteProj').onclick = async () => {
    if (!confirm(`Delete "${cur.name}" with its chat, brief and files? This can't be undone.`)) return;
    await api.projects.remove(cur.id); cur = null; await A().openScope('main'); A().show('projects'); A().toast('Project deleted');
  };

  // ---------- UPDATES ----------
  let filter = '';
  async function renderUpdates() {
    const all = await api.updates.list();
    const ups = filter ? all.filter(u => u.kind === filter) : all;
    const el = $('#updFeed');
    if (!ups.length) { el.innerHTML = `<div class="empty"><div class="bell-art" aria-hidden="true">${I.kind.notice}</div>${filter ? 'Nothing here yet.' : 'All quiet. Scheduled runs, background tasks and replies you missed will show up here.'}</div>`; return; }
    let lastDay = '';
    el.innerHTML = ups.map((u, i) => {
      const day = new Date(u.at).toDateString();
      const label = day === new Date().toDateString() ? 'Today' : day === new Date(Date.now() - 864e5).toDateString() ? 'Yesterday' : new Date(u.at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const head = day !== lastDay ? `<div class="day">${label}</div>` : ''; lastDay = day;
      return head + feedItem(u, false).replace('class="upd ', `style="animation-delay:${Math.min(i, 12) * 35}ms" class="upd `);
    }).join('');
    $$('.upd', el).forEach(n => {
      const u = ups.find(x => x.id === n.dataset.id);
      n.onclick = (e) => { if (e.target.closest('a')) return; n.classList.toggle('open'); if (!u.read) { u.read = true; n.classList.remove('unread'); $('.upd-dot', n)?.remove(); api.updates.read([u.id]).then(badge); } };
      const o = $('[data-open]', n); if (o) o.onclick = (e) => { e.stopPropagation(); api.updates.read([u.id]); openTarget(u); };
    });
  }
  $$('#updFilters .filter').forEach(b => b.onclick = () => { filter = b.dataset.f; $$('#updFilters .filter').forEach(x => x.classList.toggle('on', x === b)); renderUpdates(); });
  $('#updReadAll').onclick = async () => { badge(await api.updates.read(null)); renderUpdates(); };
  $('#updClear').onclick = async () => { if (!confirm('Clear all updates?')) return; await api.updates.clear(); badge(0); renderUpdates(); };

  function wireGoto(root) { $$('[data-goto]', root).forEach(b => b.onclick = () => A().show(b.dataset.goto)); }
  wireGoto(document);

  // ---------- live wiring ----------
  let view = 'home';
  window.addEventListener('orbit-view', (e) => {
    view = e.detail.view;
    if (view === 'home') renderHome();
    if (view === 'projects') renderProjects();
    if (view === 'updates') renderUpdates();
  });
  window.addEventListener('orbit-hub', (e) => {
    const t = e.detail.type;
    if (t === 'panels_changed' && view === 'home') renderPanels();
    if (t === 'projects_changed') { if (view === 'projects') renderProjects(); if (view === 'home') renderHomeProjects(); if (e.detail.project && cur && e.detail.project === cur.id) reloadCur(); else if (view === 'chat' && cur && $('#drawer').classList.contains('open')) reloadCur(); }
    if (t === 'updates_changed') { badge(e.detail.unread); if (view === 'updates') renderUpdates(); if (view === 'home') { renderHomeFeed(); pulse(); } }
    if (t === 'tasks_changed' && view === 'home') pulse();
  });
  window.addEventListener('orbit-ready', () => { renderHome(); api.ui.scope('none'); });
  setInterval(() => { if (view === 'home' && document.visibilityState === 'visible') { greet(); pulse(); $$('.panel footer span:first-child').length && renderPanels(); } }, 60000);
})();
