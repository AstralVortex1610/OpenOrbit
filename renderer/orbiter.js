// Orbiter window: sessions, transcript with tool lines and diffs, approvals, todo/changes/checkpoints, themes.
(function () {
  const O = window.orbiter;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const md = (s) => (window.renderMarkdown ? window.renderMarkdown(s) : esc(s));
  const feed = $('#feed'), input = $('#input');
  let meta = null, sessions = [], cur = null, tab = 'todo', streaming = {}, lastEsc = 0;
  // Orbiter runs inside Orbit's window: in the Orbiter view (all sessions) or inside one project (its sessions).
  const QS = new URLSearchParams(location.search);
  const PROJECT = QS.get('project') || '';
  let project = null;
  document.body.classList.add('embedded');
  if (PROJECT) document.body.classList.add('in-project');
  const THEMES = [
    { id: 'orbit-dark', name: 'Orbit Dark' }, { id: 'orbit-light', name: 'Orbit Light' }, { id: 'midnight', name: 'Midnight' },
    { id: 'dark-daltonized', name: 'Dark (colour-blind)' }, { id: 'light-daltonized', name: 'Light (colour-blind)' }, { id: 'high-contrast', name: 'High contrast' },
  ];
  const ICON = {
    read_file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>', list_dir: '<path d="M2 4.5h4l1.2 1.3H14v7H2z"/>', glob: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
    grep: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>', write_file: '<path d="M3 13h3l7-7-3-3-7 7z"/>', edit_file: '<path d="M3 13h3l7-7-3-3-7 7z"/>', multi_edit: '<path d="M3 13h3l7-7-3-3-7 7z"/>',
    bash: '<path d="m3 4 4 4-4 4M8.5 12.5H13"/>', todo_write: '<path d="m3 5 1.5 1.5L7 4M3 11l1.5 1.5L7 10M9 5.5h4.5M9 11.5h4.5"/>', web_search: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>',
    web_fetch: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/>', ask_user: '<circle cx="8" cy="8" r="5.5"/><path d="M6.5 6.3a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.6-.7 1.1M8 11h0"/>', exit_plan_mode: '<path d="M4 2.5h8v11H4zM6 6h4M6 8.5h4M6 11h2"/>',
  };
  const SLASH = [
    ['/help', 'Commands and shortcuts'], ['/clear', 'Start this session fresh'], ['/compact', 'Summarise the conversation to free context'], ['/init', 'Write ORBITER.md for this codebase'],
    ['/model', 'Pick Spark, Pulse or Surge'], ['/permissions', 'Change the permission mode'], ['/plan', 'Switch to plan mode'], ['/theme', 'Change the theme'],
    ['/rewind', 'Undo back to a checkpoint'], ['/memory', 'Open ORBITER.md memory files'], ['/review', 'Review the uncommitted changes'], ['/todos', 'Show the task list'],
    ['/cost', 'Tokens this session and today'], ['/status', 'Session, folder, model and mode'], ['/export', 'Copy the conversation as markdown'], ['/config', 'Orbiter settings'],
  ];
  const modeOf = (id) => (meta.modes.find(m => m.id === id) || meta.modes[0]);
  const choiceOf = (id) => { const c = (meta.choices || []).find(x => x.id === (id || '')); return c || { id: '', name: 'Main', model: '' }; };
  const tierOf = (id) => { const c = choiceOf(id); const main = choiceOf(''); return { id: c.id, name: c.name, model: c.model || main.model, inherited: !!c.id && !c.model }; };
  const toast = (t) => { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 2400); };

  // ---------- theme ----------
  const SCENES = window.ORBITER_BACKDROPS || [];
  function applyTheme(id) {
    const root = document.documentElement; root.removeAttribute('style');
    document.body.classList.remove('scene', ...SCENES.map(x => x.cls).filter(Boolean));
    const bd = $('#backdrop'); bd.innerHTML = '';
    const custom = (meta.themes || []).find(t => t.id === id);
    const scene = SCENES.find(t => t.id === id) || (custom && SCENES.find(t => t.id === custom.scene));
    const setVars = (o) => { for (const [k, v] of Object.entries(o || {})) root.style.setProperty(k.startsWith('--') ? k : '--' + k, v); };
    if (scene) { root.dataset.theme = scene.base; setVars(scene.overrides); bd.innerHTML = scene.svg; document.body.classList.add('scene'); if (scene.cls) document.body.classList.add(scene.cls); }
    if (custom) {
      if (!scene) root.dataset.theme = custom.base;
      setVars(custom.overrides);
      if (custom.backdropUrl) { bd.innerHTML = ''; const img = new Image(); img.src = custom.backdropUrl; bd.appendChild(img); document.body.classList.add('scene'); }
    } else if (!scene) root.dataset.theme = THEMES.some(t => t.id === id) ? id : 'orbit-dark';
    $('#themeName').textContent = (custom || scene || THEMES.find(t => t.id === id) || THEMES[0]).name;
  }
  function themePicker() {
    const all = [...THEMES, ...(meta.themes || [])];
    const sel = meta.settings.orbiterTheme || 'orbit-dark';
    const sceneCards = SCENES.map(t => `<button class="th ${t.id === sel ? 'on' : ''}" data-id="${esc(t.id)}"><div class="pv scene">${t.svg}<div class="mini"><i style="width:80%"></i><i style="width:60%"></i><i style="width:70%;background:${esc(t.overrides.accent || '#c4673a')}"></i></div></div><div class="nm">${esc(t.name)}</div></button>`).join('');
    const rootStyle = document.documentElement.style.cssText; document.documentElement.style.cssText = '';
    const prev = (t) => { const tmp = document.createElement('div'); tmp.dataset.theme = t.base || t.id; document.body.appendChild(tmp); const cs = getComputedStyle(tmp); const g = (k) => (t.overrides && (t.overrides[k] || t.overrides['--' + k])) || cs.getPropertyValue('--' + k).trim(); const v = { bg: g('bg'), raised: g('raised'), text: g('text'), add: g('add'), del: g('del'), accent: g('accent'), dim: g('dim') }; tmp.remove(); return v; };
    const colourCards = all.map(t => [t, prev(t)]); document.documentElement.style.cssText = rootStyle;
    overlay(`<h2>Theme</h2><p class="sub">Hover to preview, click to keep. Scenes put art behind the whole window. Custom themes are JSON files in your themes folder and can use your own picture.</p>
      <div class="th-sec">Scenes</div><div class="themes">${sceneCards}</div><div class="th-sec">Colours</div>
      <div class="themes">${colourCards.map(([t, c]) => { return `<button class="th ${t.id === sel ? 'on' : ''}" data-id="${esc(t.id)}"><div class="pv" style="background:${c.bg};color:${c.dim}"><div class="l" style="width:70%;background:${c.raised}"></div><div class="l" style="width:85%;background:${c.add};opacity:.55"></div><div class="l" style="width:60%;background:${c.del};opacity:.55"></div><div class="l" style="width:35%;background:${c.accent}"></div></div><div class="nm">${esc(t.name)}${t.id.startsWith('custom:') ? ' · custom' : ''}</div></button>`; }).join('')}</div>
      <div class="foot"><button class="btn" id="newTheme">New custom theme…</button><button class="btn" id="thClose">Done</button></div>`, (d) => {
      d.querySelectorAll('.th').forEach(b => { b.onmouseenter = () => applyTheme(b.dataset.id); b.onclick = async () => { meta.settings.orbiterTheme = b.dataset.id; await O.saveSettings({ orbiterTheme: b.dataset.id }); closeOverlay(); applyTheme(b.dataset.id); }; });
      d.querySelectorAll('.themes').forEach(g => g.onmouseleave = () => applyTheme(meta.settings.orbiterTheme));
      $('#thClose', d).onclick = closeOverlay;
      $('#newTheme', d).onclick = () => customTheme();
    });
  }
  function customTheme() {
    overlay(`<h2>New custom theme</h2><p class="sub">Start from a built-in theme and override any colour token (bg, panel, raised, text, dim, accent, add, del, warn…). Colours can be #hex or rgb().</p>
      <div class="field"><label>Name</label><input id="ctName" value="My theme" /></div>
      <div class="field"><label>Based on</label><input id="ctBase" value="${esc(meta.settings.orbiterTheme && !meta.settings.orbiterTheme.startsWith('custom:') ? meta.settings.orbiterTheme : 'orbit-dark')}" /></div>
      <div class="field"><label>Scene art (optional: a scene name like scene:paris-night, or put "backdrop": "my-picture.jpg" in the JSON file and drop the picture in the themes folder)</label><input id="ctScene" placeholder="none" /></div>
      <div class="field"><label>Overrides (JSON)</label><textarea id="ctOv">{\n  "accent": "#5fb3a8",\n  "bg": "#101614"\n}</textarea></div>
      <div class="foot"><button class="btn" id="ctCancel">Cancel</button><button class="btn pri" id="ctSave">Save and use</button></div>`, (d) => {
      $('#ctCancel', d).onclick = closeOverlay;
      $('#ctSave', d).onclick = async () => {
        let ov; try { ov = JSON.parse($('#ctOv', d).value || '{}'); } catch { return toast('Overrides must be valid JSON'); }
        const name = $('#ctName', d).value.trim() || 'My theme';
        const id = await O.saveTheme(name, { name, base: $('#ctBase', d).value.trim(), overrides: ov, scene: $('#ctScene', d).value.trim() || undefined });
        meta = await O.meta(); meta.settings.orbiterTheme = id; await O.saveSettings({ orbiterTheme: id }); applyTheme(id); closeOverlay(); toast('Theme saved');
      };
    });
  }
  function overlay(html, wire) { const o = $('#overlay'); o.innerHTML = `<div class="dlg">${html}</div>`; o.hidden = false; o.onclick = (e) => { if (e.target === o) closeOverlay(); }; wire && wire(o.firstChild); }
  function closeOverlay() { $('#overlay').hidden = true; $('#overlay').innerHTML = ''; }

  // ---------- sessions ----------
  async function loadSessions() {
    sessions = (await O.sessions()).filter(x => !PROJECT || x.projectId === PROJECT);
    $('#sessList').innerHTML = sessions.map(s => `<button class="sess ${cur && s.id === cur.id ? 'on' : ''} ${s.busy ? 'busy' : ''}" data-id="${s.id}"><i class="dot"></i><span class="n">${esc(s.name)}</span><span class="s">${s.busy ? esc(s.step || 'Working') : esc(shortPath(s.folder))}</span></button>`).join('') || '<div class="pane-empty">No sessions yet.</div>';
    $('#sessList').querySelectorAll('.sess').forEach(b => b.onclick = () => open(b.dataset.id));
  }
  const shortPath = (p) => { const parts = String(p || '').split(/[\\/]/).filter(Boolean); return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p; };

  async function newSession() {
    // In a project the session starts in the project's folder with the project's model; change either from the chips.
    const folder = project ? project.folder : await O.pickFolder(); if (!folder) return;
    const s = await O.create(project ? { folder, projectId: project.id, name: `${project.name} · ${sessions.length + 1}`, tier: project.tier || '' } : { folder });
    await loadSessions(); open(s.id);
  }
  async function changeFolder() {
    if (!cur) return newSession();
    overlay(`<h2>Working folder</h2><p class="sub mono">${esc(cur.folder)}</p><button class="opt" data-a="open"><div><b>Open in Explorer</b><span>See the files</span></div></button><button class="opt" data-a="change"><div><b>Change folder</b><span>Point this session at another folder</span></div></button>`, (d) => d.querySelectorAll('.opt').forEach(b => b.onclick = async () => {
      closeOverlay();
      if (b.dataset.a === 'open') return O.openPath(cur.folder);
      const f = await O.pickFolder(); if (!f) return; cur = await O.update(cur.id, { folder: f }); paintChips(); paintTitle(); toast('Folder changed');
    }));
  }
  async function open(id) {
    cur = await O.session(id); if (!cur) return;
    streaming = {};
    await loadSessions(); paintChips(); paintTitle();
    const [thread, diffs] = await Promise.all([O.thread(id), O.diffs(id)]);
    renderThread(thread, diffs); renderPane(); input.focus();
    const me = sessions.find(x => x.id === id);
    if (me && me.busy) working(true, me.step, me.started);
    try { for (const e of await O.pending(id)) if (!feed.querySelector(`.ask[data-ask="${e.id}"]`)) addAsk(e); } catch {}
  }
  // ---------- "Orbiter is working" row: always at the bottom while a session runs ----------
  let workT = null, workAt = 0;
  function working(on, label, since) {
    let w = feed.querySelector('.working');
    if (!on) { if (w) w.remove(); clearInterval(workT); workT = null; return; }
    if (!w) { w = document.createElement('div'); w.className = 'working'; w.innerHTML = '<span class="orb"><i></i><i></i><i></i></span><span class="wl"></span><span class="wt"></span>'; feed.appendChild(w); workAt = since || Date.now(); }
    else if (since) workAt = since;
    if (label) w.querySelector('.wl').textContent = label;
    else if (!w.querySelector('.wl').textContent) w.querySelector('.wl').textContent = 'Thinking';
    const tick = () => { const s2 = Math.max(0, Math.round((Date.now() - workAt) / 1000)); w.querySelector('.wt').textContent = s2 < 60 ? `${s2}s` : `${Math.floor(s2 / 60)}m ${s2 % 60}s`; };
    tick(); if (!workT) workT = setInterval(tick, 1000);
    scroll();
  }
  function paintTitle() { $('#tbSess').innerHTML = cur ? `<b>${esc(cur.name)}</b><span class="path">${esc(cur.folder)}</span>` : ''; }
  function paintChips() {
    const m = modeOf(cur ? cur.mode : meta.settings.orbiterMode), t = tierOf(cur ? cur.tier : project ? project.tier : meta.settings.orbiterTier);
    const mc = $('#modeChip'); mc.style.setProperty('--mc', `var(--m-${m.id})`); mc.querySelector('span').textContent = m.name;
    $('#composer').className = 'composer m-' + m.id;
    $('#tierChip span').textContent = `${t.name}${t.model ? ' · ' + t.model : ''}`;
    $('#tierChip').title = t.inherited ? `${t.name} has no model of its own yet, so it uses the main model. Set it in Settings → Brain.` : 'Model (applies at once, even mid-task)';
    $('#folderChip span').textContent = cur ? shortPath(cur.folder) : project ? `${project.name} files` : 'Pick a folder';
    const tok = cur ? cur.tokens || 0 : 0; $('#ctxMeter').textContent = tok ? `${tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : tok} tok` : '';
    const busy = cur && sessions.find(s => s.id === cur.id && s.busy);
    $('#sendBtn').classList.toggle('stop', !!busy);
    $('#sendBtn').innerHTML = busy ? '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>';
  }

  // ---------- transcript ----------
  function emptyState() {
    feed.innerHTML = `<div class="empty"><div class="logo"><img src="mark.png" alt="" /></div><h1>What are we building${cur ? ' in ' + esc(cur.name) : ''}?</h1><p>${cur ? 'Orbiter reads the code, plans, edits and runs your tests. You approve what matters.' : project ? `Type below to start coding in ${esc(project.name)}'s folder, or open another folder.` : 'Open a folder to start a coding session.'}</p>
      <div class="starts">${cur ? [['Explain this codebase', 'Walk me through how this project is structured and where the main logic lives.'], ['Write ORBITER.md', '/init'], ['Find and fix a bug', 'Run the tests, find what fails, and fix it.'], ['Plan a feature', '/plan']].map(([b, p]) => `<button data-p="${esc(p)}"><b>${b}</b><span>${p.startsWith('/') ? p : esc(p.slice(0, 54)) + '…'}</span></button>`).join('') : (project ? `<button data-new="1"><b>Start in ${esc(project.name)}</b><span>Uses this project's folder and model</span></button><button data-pick="1"><b>Open another folder</b><span>Code somewhere else for this project</span></button>` : `<button data-new="1"><b>Open folder</b><span>Start a new session</span></button>`)}</div></div>`;
    feed.querySelectorAll('.starts button').forEach(b => b.onclick = async () => { if (b.dataset.pick) { const f = await O.pickFolder(); if (!f) return; const s2 = await O.create({ folder: f, projectId: project.id, name: `${project.name} · ${sessions.length + 1}`, tier: project.tier || '' }); await loadSessions(); return open(s2.id); } if (b.dataset.new) return newSession(); input.value = b.dataset.p; submit(); });
  }
  function renderThread(thread, diffs = []) {
    feed.innerHTML = '';
    if (!thread.length) return emptyState();
    const toolRes = new Map(thread.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m]));
    const dq = [...diffs];
    for (const m of thread) {
      if (m.role === 'user') addUser(m.display || m.content, m.compact, m.checkpoint);
      else if (m.role === 'assistant') {
        if (m.content) addAssistant(m.content);
        for (const c of m.tool_calls || []) {
          let a = {}; try { a = JSON.parse(c.args || '{}'); } catch {}
          const r = toolRes.get(c.id); const text = r ? r.content : '';
          addTool({ id: c.id, name: c.name, args: a, label: labelFor(c.name, a), done: true, ok: !String(text).startsWith('Error'), preview: text });
          if (['write_file', 'edit_file', 'multi_edit'].includes(c.name) && r && !String(text).startsWith('Error')) { const i = dq.findIndex(d => d.at >= (r.at || 0) - 5000); if (i >= 0) addDiff(dq.splice(i, 1)[0]); }
        }
      }
    }
    scroll(true);
  }
  function el(cls, html) { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; const w = feed.querySelector('.working'); w ? feed.insertBefore(d, w) : feed.appendChild(d); return d; }
  function clearEmpty() { const e = feed.querySelector('.empty'); if (e) e.remove(); }
  function addUser(text, compact, checkpoint) {
    clearEmpty();
    const d = el('u', `<div class="uw"><div class="b ${compact ? 'compact' : ''}">${esc(text)}</div>${checkpoint && !compact ? '<button class="u-edit" title="Edit and resend (undoes what came after)"><svg viewBox="0 0 16 16"><path d="M3 13h3l7-7-3-3-7 7z"/></svg>Edit</button>' : ''}</div>`);
    const b = d.querySelector('.u-edit'); if (b) b.onclick = () => editUser(d, text, checkpoint);
  }
  // Edit an earlier message: undo the code and chat back to it, then send the new words.
  function editUser(d, text, checkpoint) {
    if (d.classList.contains('editing')) return; d.classList.add('editing');
    const bub = d.querySelector('.b'); const box = document.createElement('div'); box.className = 'ueb';
    box.innerHTML = `<textarea rows="3"></textarea><div class="uebar"><span>Undoes the changes made after this message, then redoes it.</span><button class="btn" data-x>Cancel</button><button class="btn pri" data-ok>Save and send</button></div>`;
    const ta = box.querySelector('textarea'); ta.value = text; bub.after(box); bub.hidden = true; ta.focus();
    const close = () => { box.remove(); bub.hidden = false; d.classList.remove('editing'); };
    box.querySelector('[data-x]').onclick = close;
    const ok = async () => {
      const v = ta.value.trim(); if (!v || !cur) return; if (v === text) return close();
      if (sessions.find(x => x.id === cur.id && x.busy)) { await O.stop(cur.id); for (let i = 0; i < 60 && (await O.sessions()).find(x => x.id === cur.id && x.busy); i++) await new Promise(r => setTimeout(r, 100)); }
      const r = await O.rewind(cur.id, checkpoint, { code: true, chat: true });
      if (!r || !r.ok) { toast((r && r.error) || "Couldn't edit that message."); return close(); }
      await open(cur.id); addUser(v); scroll(true); O.send(cur.id, v);
    };
    box.querySelector('[data-ok]').onclick = ok;
    ta.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ok(); } else if (ev.key === 'Escape') close(); };
  }
  function addAssistant(text, id) { clearEmpty(); const d = el('a', `<div class="md">${md(text)}</div>`); if (id) d.dataset.id = id; return d; }
  function addTool(t) {
    clearEmpty();
    const d = el(`tool ${t.done ? (t.ok ? '' : 'bad') : 'run'}`, `<button class="row"><span class="ic"><svg viewBox="0 0 16 16">${ICON[t.name] || '<circle cx="8" cy="8" r="2"/>'}</svg></span><span class="lbl">${toolLabelHtml(t.label)}</span></button><div class="out"></div>`);
    d.dataset.id = t.id; d.querySelector('.out').textContent = t.preview || '';
    d.querySelector('.row').onclick = () => d.classList.toggle('open');
    return d;
  }
  const toolLabelHtml = (l) => { const m = String(l).match(/^(\S+(?: \S+)?)\s(.*)$/); return m ? `${esc(m[1])} <b>${esc(m[2])}</b>` : esc(l); };
  function addDiff(dfx) { clearEmpty(); const d = el('diff', diffHtml(dfx)); return d; }
  // Line diff (LCS) with 3 lines of context; big files fall back to a trimmed prefix/suffix diff.
  function diffLines(before, after) {
    const a = before == null ? [] : String(before).split('\n'), b = String(after).split('\n');
    let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const A = a.slice(s, ea), B = b.slice(s, eb); const ops = [];
    if (A.length * B.length <= 400000) {
      const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) { ops.push({ k: '', ai: s + i, bi: s + j }); i++; j++; }
        else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push({ k: 'del', ai: s + i }); i++; }
        else { ops.push({ k: 'add', bi: s + j }); j++; }
      }
    } else { A.forEach((_, i) => ops.push({ k: 'del', ai: s + i })); B.forEach((_, j) => ops.push({ k: 'add', bi: s + j })); }
    const all = [];
    for (let i = 0; i < s; i++) all.push({ k: '', n: i + 1, t: b[i] });
    for (const o of ops) all.push(o.k === 'del' ? { k: 'del', n: o.ai + 1, t: a[o.ai] } : { k: o.k, n: o.bi + 1, t: b[o.bi] });
    for (let j = eb; j < b.length; j++) all.push({ k: '', n: j + 1, t: b[j] });
    const keep = all.map((l, i) => l.k !== '' || all.slice(Math.max(0, i - 3), i + 4).some(x => x.k !== ''));
    const out = []; let gap = 0;
    all.forEach((l, i) => { if (keep[i]) { if (gap) out.push({ k: 'gap', t: `⋯ ${gap} unchanged line${gap > 1 ? 's' : ''}` }); gap = 0; out.push(l); } else gap++; });
    if (gap) out.push({ k: 'gap', t: `⋯ ${gap} unchanged line${gap > 1 ? 's' : ''}` });
    return { out: out.slice(0, 400), plus: all.filter(l => l.k === 'add').length, minus: all.filter(l => l.k === 'del').length };
  }
  function diffHtml(dfx) {
    const { out, plus, minus } = diffLines(dfx.before, dfx.after);
    return `<div class="card"><div class="hd"><svg viewBox="0 0 16 16"><path d="M3 13h3l7-7-3-3-7 7z"/></svg><span class="f">${esc(dfx.rel || dfx.path)}</span>${dfx.before == null ? '<span class="chg"><span class="tag">new</span></span>' : ''}<span class="st"><span class="p">+${plus}</span> <span class="m">−${minus}</span></span></div><div class="body">${out.map(l => l.k === 'gap' ? `<div class="dl gap">${esc(l.t)}</div>` : `<div class="dl ${l.k}"><span class="ln">${l.n}</span><span class="sg">${l.k === 'add' ? '+' : l.k === 'del' ? '−' : ' '}</span><span>${esc(l.t)}</span></div>`).join('')}</div></div>`;
  }
  function addAsk(e) {
    clearEmpty();
    const plan = e.title === 'Approve this plan?';
    const isQ = e.type === 'question';
    const d = el('ask', `<div class="card"><div class="t"><i></i>${esc(isQ ? e.question : plan ? 'Ready to code? Here is the plan' : e.title)}</div>${isQ ? '' : plan ? `<div class="md">${md(e.detail)}</div>` : `<pre>${esc(e.detail || '')}</pre>`}
      <div class="btns">${isQ ? (e.choices || []).map(c => `<button class="btn" data-a="${esc(c)}">${esc(c)}</button>`).join('') + '<button class="btn" data-free="1">Type an answer…</button>' : plan ? '<button class="btn pri" data-ok="1">Approve and start</button><button class="btn" data-ok="0">Keep planning</button>' : `<button class="btn pri" data-ok="1">Allow</button>${/^Run/.test(e.title) ? '<button class="btn" data-always="1">Always allow this command</button>' : ''}<button class="btn" data-ok="0">Deny</button>`}</div><div class="res"></div></div>`);
    d.dataset.ask = e.id;
    d.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => O.answerApproval(e.id, b.dataset.ok === '1'));
    const al = d.querySelector('[data-always]'); if (al) al.onclick = async () => { const first = String(e.detail || '').trim().split(/\s+/).slice(0, 2).join(' '); const list = [...(meta.settings.orbiterAllow || []), first]; meta.settings.orbiterAllow = list; await O.saveSettings({ orbiterAllow: list }); O.answerApproval(e.id, true); toast(`"${first}" won't ask again`); };
    d.querySelectorAll('[data-a]').forEach(b => b.onclick = () => O.answerQuestion(e.id, b.dataset.a));
    const fr = d.querySelector('[data-free]'); if (fr) fr.onclick = () => { input.focus(); input.dataset.answer = e.id; input.placeholder = 'Your answer…'; };
    scroll();
  }
  function scroll(force) { const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160; if (force || near) feed.scrollTop = feed.scrollHeight; }

  // ---------- right pane ----------
  async function renderPane() {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    const body = $('#paneBody');
    if (!cur) { body.innerHTML = '<div class="pane-empty">Open a session to see its tasks, changes and checkpoints.</div>'; return; }
    if (tab === 'todo') {
      const todos = cur.todos || [];
      if (!todos.length) { body.innerHTML = '<div class="pane-empty">Orbiter makes a task list for any job with three or more steps.</div>'; return; }
      const done = todos.filter(t => t.status === 'completed').length;
      body.innerHTML = `<div class="prog-l">${done} of ${todos.length} done</div><div class="prog"><i style="width:${Math.round(done / todos.length * 100)}%"></i></div>` + todos.map(t => `<div class="todo ${t.status}"><span class="box"></span><span class="tx">${esc(t.content)}</span></div>`).join('');
    } else if (tab === 'changes') {
      const diffs = await O.diffs(cur.id); const by = new Map();
      for (const d of diffs) { const p = by.get(d.path); by.set(d.path, { ...d, before: p ? p.before : d.before }); }
      body.innerHTML = by.size ? [...by.values()].map(d => `<button class="chg" data-p="${esc(d.path)}"><span class="tag ${d.before == null ? '' : 'm'}">${d.before == null ? 'A' : 'M'}</span><span class="f">${esc(d.rel)}</span></button>`).join('') : '<div class="pane-empty">No files changed yet.</div>';
      body.querySelectorAll('.chg').forEach(b => b.onclick = () => { const d = by.get(b.dataset.p); overlay(`<h2 class="mono" style="font-size:14px">${esc(d.rel)}</h2><p class="sub">All changes this session</p>${diffHtml(d)}<div class="foot"><button class="btn" id="opF">Open file</button><button class="btn" id="clF">Close</button></div>`, (x) => { $('#clF', x).onclick = closeOverlay; $('#opF', x).onclick = () => O.openPath(d.path); }); });
    } else {
      const cps = (await O.checkpoints(cur.id)).reverse();
      body.innerHTML = cps.length ? cps.map(c => `<div class="cp"><div class="p">${esc(c.prompt)}</div><div class="m">${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${c.files.length} file${c.files.length === 1 ? '' : 's'}<button data-id="${c.id}">Rewind here</button></div></div>`).join('') : '<div class="pane-empty">Every message you send makes a checkpoint you can rewind to.</div>';
      body.querySelectorAll('[data-id]').forEach(b => b.onclick = () => rewindDialog(b.dataset.id));
    }
  }
  async function rewindDialog(cpId) {
    const cps = (await O.checkpoints(cur.id)).reverse(); if (!cps.length) return toast('No checkpoints yet');
    const pick = cpId || cps[0].id;
    overlay(`<h2>Rewind</h2><p class="sub">Go back to before a message. Files Orbiter changed after it are restored.</p>${cps.map(c => `<button class="opt ${c.id === pick ? 'on' : ''}" data-id="${c.id}"><div><b>${esc(c.prompt)}</b><span>${c.files.length} file${c.files.length === 1 ? '' : 's'} changed after this</span></div><span class="k">${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></button>`).join('')}
      <div class="foot"><button class="btn" id="rwCancel">Cancel</button><button class="btn" id="rwChat">Conversation only</button><button class="btn" id="rwCode">Code only</button><button class="btn pri" id="rwBoth">Code and conversation</button></div>`, (d) => {
      let sel = pick; d.querySelectorAll('.opt').forEach(b => b.onclick = () => { sel = b.dataset.id; d.querySelectorAll('.opt').forEach(x => x.classList.toggle('on', x === b)); });
      $('#rwCancel', d).onclick = closeOverlay;
      const go = async (code, chat) => { const r = await O.rewind(cur.id, sel, { code, chat }); closeOverlay(); if (!r.ok) return toast(r.error); toast(`Rewound · ${r.restored} file${r.restored === 1 ? '' : 's'} restored`); if (chat) input.value = r.prompt; open(cur.id); };
      $('#rwChat', d).onclick = () => go(false, true); $('#rwCode', d).onclick = () => go(true, false); $('#rwBoth', d).onclick = () => go(true, true);
    });
  }

  // ---------- pickers ----------
  function modePicker() {
    overlay(`<h2>Permission mode</h2><p class="sub">Shift+Tab cycles through these in the prompt box.</p>${meta.modes.map(m => `<button class="opt ${cur && cur.mode === m.id ? 'on' : ''}" data-id="${m.id}" style="--mc:var(--m-${m.id})"><div><b style="color:var(--mc)">${m.name}</b><span>${m.blurb}</span></div></button>`).join('')}`, (d) => d.querySelectorAll('.opt').forEach(b => b.onclick = () => { setMode(b.dataset.id); closeOverlay(); }));
  }
  async function setMode(id) { if (!cur) { meta.settings.orbiterMode = id; await O.saveSettings({ orbiterMode: id }); } else cur = await O.update(cur.id, { mode: id }); paintChips(); }
  function tierPicker() {
    const now = cur ? (cur.tier || '') : (meta.settings.orbiterTier || '');
    const blurb = { '': 'Your main model from Settings → Brain.', spark: 'Fast and cheap. Quick edits, questions, small fixes.', pulse: 'Balanced. Everyday coding.', surge: 'Strongest. Hard bugs, big refactors, planning.' };
    overlay(`<h2>Model</h2><p class="sub">Switching takes over at once, even in the middle of a task. Spark, Pulse and Surge are models on your Brain provider.</p>${(meta.choices || []).map(c => `<button class="opt ${now === c.id ? 'on' : ''}" data-id="${c.id}"><div><b>${esc(c.name)}</b><span>${blurb[c.id] || ''}</span></div><span class="k">${c.model ? esc(c.model) : 'not set · uses main'}</span></button>`).join('')}`, (d) => d.querySelectorAll('.opt').forEach(b => b.onclick = async () => {
      const id = b.dataset.id;
      if (cur) { await O.pickModel(cur.id, id); cur = await O.session(cur.id) || cur; } else { meta.settings.orbiterTier = id; await O.saveSettings({ orbiterTier: id }); }
      paintChips(); closeOverlay(); toast(`Now using ${tierOf(id).name} · ${tierOf(id).model}`);
    }));
  }
  function settingsDlg() {
    overlay(`<h2>Orbiter settings</h2><p class="sub">Defaults for new sessions. Models are mapped in Orbit Settings → Models.</p>
      <div class="field"><label>Default model for new sessions</label><div>${(meta.choices || []).map(t => `<button class="chip" data-tier="${t.id}" style="display:inline-flex;margin:0 6px 6px 0;${(meta.settings.orbiterTier || '') === t.id ? 'border-color:var(--accent);color:var(--text)' : ''}">${t.name}</button>`).join('')}</div></div>
      <div class="field"><label>Default permission mode</label><div>${meta.modes.map(m => `<button class="chip" data-mode="${m.id}" style="display:inline-flex;margin:0 6px 6px 0;${meta.settings.orbiterMode === m.id ? 'border-color:var(--accent);color:var(--text)' : ''}">${m.name}</button>`).join('')}</div></div>
      <div class="field"><label>Commands that never ask (one prefix per line, e.g. npm test)</label><textarea id="allow">${esc((meta.settings.orbiterAllow || []).join('\n'))}</textarea></div>
      <div class="foot"><button class="btn" id="sClose">Cancel</button><button class="btn pri" id="sSave">Save</button></div>`, (d) => {
      let tier = meta.settings.orbiterTier || '', mode = meta.settings.orbiterMode;
      d.querySelectorAll('[data-tier]').forEach(b => b.onclick = () => { tier = b.dataset.tier; d.querySelectorAll('[data-tier]').forEach(x => x.style.borderColor = x === b ? 'var(--accent)' : ''); });
      d.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; d.querySelectorAll('[data-mode]').forEach(x => x.style.borderColor = x === b ? 'var(--accent)' : ''); });
      $('#sClose', d).onclick = closeOverlay;
      $('#sSave', d).onclick = async () => { const allow = $('#allow', d).value.split('\n').map(x => x.trim()).filter(Boolean); Object.assign(meta.settings, { orbiterTier: tier, orbiterMode: mode, orbiterAllow: allow }); await O.saveSettings({ orbiterTier: tier, orbiterMode: mode, orbiterAllow: allow }); closeOverlay(); toast('Saved'); };
    });
  }

  // ---------- slash ----------
  let slashSel = 0;
  function slashMenu() {
    const v = input.value; const box = $('#slash');
    if (!/^\/\S*$/.test(v)) { box.hidden = true; return; }
    const list = SLASH.filter(([c]) => c.startsWith(v.toLowerCase()));
    if (!list.length) { box.hidden = true; return; }
    slashSel = Math.min(slashSel, list.length - 1);
    box.innerHTML = list.map(([c, d], i) => `<button class="${i === slashSel ? 'on' : ''}" data-c="${c}"><span class="c">${c}</span><span class="d">${d}</span></button>`).join(''); box.hidden = false;
    box.querySelectorAll('button').forEach(b => b.onmousedown = (e) => { e.preventDefault(); input.value = b.dataset.c; box.hidden = true; submit(); });
  }
  async function runSlash(cmd, arg) {
    switch (cmd) {
      case '/help': overlay(`<h2>Orbiter commands</h2><p class="sub">Type / in the prompt box. Shortcuts: Enter send · Shift+Enter new line · Shift+Tab mode · Esc stop · Esc Esc rewind · Ctrl+N new session · Ctrl+T theme</p>${SLASH.map(([c, d]) => `<div class="opt"><div><b class="mono">${c}</b><span>${d}</span></div></div>`).join('')}`); return;
      case '/clear': await O.clear(cur.id); open(cur.id); return toast('Session cleared');
      case '/compact': { toast('Compacting…'); const r = await O.compact(cur.id, arg); if (!r.ok) return toast(r.error); return open(cur.id); }
      case '/init': await O.init(cur.id); return;
      case '/model': return tierPicker();
      case '/permissions': return modePicker();
      case '/plan': await setMode('plan'); if (arg) { input.value = arg; return submit(); } return toast('Plan mode: Orbiter will read and plan, then ask before changing anything');
      case '/theme': return themePicker();
      case '/rewind': return rewindDialog();
      case '/memory': { const l = await O.memory(cur.id); overlay(`<h2>Memory</h2><p class="sub">Orbiter reads these every turn. Create ORBITER.md in the project (or run /init) to teach it your conventions.</p>${l.length ? l.map(m => `<button class="opt" data-p="${esc(m.path)}"><div><b>${esc(m.scope)}</b><span class="mono">${esc(m.path)}</span></div><span class="k">${m.size} chars</span></button>`).join('') : '<div class="pane-empty">No memory files yet.</div>'}`, (d) => d.querySelectorAll('[data-p]').forEach(b => b.onclick = () => O.openPath(b.dataset.p))); return; }
      case '/review': input.value = 'Review the uncommitted changes in this repo (git diff). List real bugs, risks and missing tests by file:line, most important first. Don\'t change anything.'; return submit(true);
      case '/todos': tab = 'todo'; return renderPane();
      case '/cost': { const u = await O.usage(); return toast(`This session: ${(cur.tokens || 0).toLocaleString()} tokens · Today: ${(u.tokensToday || 0).toLocaleString()} tokens`); }
      case '/status': return overlay(`<h2>Status</h2><div class="opt"><div><b>Session</b><span>${esc(cur.name)}</span></div></div><div class="opt"><div><b>Folder</b><span class="mono">${esc(cur.folder)}</span></div></div><div class="opt"><div><b>Model</b><span>${esc($('#tierChip span').textContent)}</span></div></div><div class="opt"><div><b>Mode</b><span>${esc(modeOf(cur.mode).name)}</span></div></div><div class="opt"><div><b>Version</b><span>Orbit ${esc(meta.version)} (beta)</span></div></div>`);
      case '/export': { const t = await O.thread(cur.id); const text = t.filter(m => m.role !== 'tool' && (m.display || m.content)).map(m => `**${m.role === 'user' ? 'You' : 'Orbiter'}:** ${m.display || m.content}`).join('\n\n'); await navigator.clipboard.writeText(text); return toast('Conversation copied as markdown'); }
      case '/config': return settingsDlg();
      default: toast(`Unknown command ${cmd}. Try /help`);
    }
  }

  // ---------- send ----------
  async function submit(raw) {
    const text = input.value.trim(); if (!text) return;
    if (input.dataset.answer) { O.answerQuestion(input.dataset.answer, text); delete input.dataset.answer; input.placeholder = 'Ask Orbiter to build, fix or explain…  ( / for commands, @ for files )'; input.value = ''; return; }
    $('#slash').hidden = true;
    if (!cur) { const folder = project ? project.folder : await O.pickFolder(); if (!folder) return; cur = await O.create(project ? { folder, projectId: project.id, name: `${project.name} · 1`, tier: project.tier || '' } : { folder }); await loadSessions(); paintChips(); paintTitle(); }
    if (!raw && text.startsWith('/')) { const [cmd, ...rest] = text.split(' '); input.value = ''; autoGrow(); return runSlash(cmd.toLowerCase(), rest.join(' ').trim()); }
    input.value = ''; autoGrow(); input.placeholder = 'Ask Orbiter to build, fix or explain…  ( / for commands, @ for files )';
    addUser(text); scroll(true); working(true, 'Thinking', Date.now());
    await O.send(cur.id, text);
  }
  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }

  // ---------- live events ----------
  function onEvent(e) {
    if (e.type === 'open_session') return open(e.session);
    if (e.type === 'models_changed') { O.meta().then(m => { meta = m; if (cur) O.session(cur.id).then(x => { if (x) cur = x; paintChips(); }); else paintChips(); }); return; }
    if (e.type === 'orbiter_sessions' || e.type === 'orbiter_busy') { loadSessions().then(async () => { if (cur) { cur = await O.session(cur.id) || cur; paintChips(); renderPane(); } }); }
    if (!cur || e.session !== cur.id) return;
    switch (e.type) {
      case 'orbiter_busy': if (e.busy) { working(true, 'Thinking', Date.now()); } else { working(false); const last = [...feed.querySelectorAll('.a .md')].pop(); if (last && /\?\s*$/.test(last.textContent.trim().slice(-200))) { input.placeholder = 'Reply to Orbiter…'; input.focus(); } } break;
      case 'orbiter_step': working(true, e.label); break;
      case 'assistant_start': working(true, 'Writing'); streaming[e.id] = ''; addAssistant('', e.id).querySelector('.md').classList.add('cursor'); break;
      case 'delta': { streaming[e.id] = (streaming[e.id] || '') + e.text; const d = feed.querySelector(`.a[data-id="${e.id}"] .md`); if (d) d.innerHTML = md(streaming[e.id]); scroll(); break; }
      case 'assistant_end': { const d = feed.querySelector(`.a[data-id="${e.id}"]`); if (d) { d.querySelector('.md').classList.remove('cursor'); d.querySelector('.md').innerHTML = md(e.text); } else if (!e.interim) addAssistant(e.text, e.id); scroll(); break; }
      case 'tool_start': working(true, e.label); addTool({ id: e.id, name: e.name, label: e.label, args: e.args }); scroll(); break;
      case 'tool_end': { const d = feed.querySelector(`.tool[data-id="${e.id}"]`); if (d) { d.classList.remove('run'); if (!e.ok) d.classList.add('bad'); d.querySelector('.out').textContent = e.preview || ''; } break; }
      case 'orbiter_diff': addDiff(e); scroll(); if (tab === 'changes') renderPane(); break;
      case 'orbiter_todos': cur.todos = e.todos; if (tab === 'todo') renderPane(); break;
      case 'approval': case 'question': working(true, 'Waiting for you'); addAsk(e); break;
      case 'approval_done': case 'question_done': { const d = feed.querySelector(`.ask[data-ask="${e.id}"]`); if (d) { d.classList.add('done'); d.querySelector('.res').textContent = e.type === 'question_done' ? `Answered: ${e.answer}` : e.approved ? 'Allowed' : 'Denied'; } break; }
      case 'orbiter_rewound': renderPane(); break;
      case 'stream_reset': { const d = feed.querySelector(`.a[data-id="${e.id}"]`); if (d) d.remove(); delete streaming[e.id]; break; }
      case 'model_switch': el('tool', `<div class="row"><span class="ic"><svg viewBox="0 0 16 16"><path d="M3 6h9l-2.5-2.5M13 10H4l2.5 2.5"/></svg></span><span class="lbl">${e.reason === 'picked' ? `Now on <b>${esc(e.model)}</b>, picking up where ${esc(e.from)} left off` : `Switched to <b>${esc(e.model)}</b> (${esc(e.from)} unavailable)`}</span></div>`); scroll(); break;
      case 'error': el('a', `<div class="md err">${esc(e.text || e.message)}</div>`); scroll(); break;
    }
  }
  function labelFor(name, a) {
    const s = (x, n = 60) => { x = String(x || ''); return x.length > n ? x.slice(0, n) + '…' : x; };
    return ({ read_file: `Read ${s(a.path)}`, list_dir: `List ${s(a.path)}`, glob: `Find ${s(a.pattern)}`, grep: `Search ${s(a.pattern, 40)}`, write_file: `Write ${s(a.path)}`, edit_file: `Edit ${s(a.path)}`, multi_edit: `Edit ${s(a.path)}`, bash: `Run ${s(a.description || a.command)}`, todo_write: 'Update tasks', web_search: `Search web ${s(a.query)}`, web_fetch: `Fetch ${s(a.url)}`, ask_user: 'Ask you', exit_plan_mode: 'Present plan' })[name] || name;
  }

  // ---------- wiring ----------
  input.addEventListener('input', () => { autoGrow(); slashSel = 0; slashMenu(); });
  input.addEventListener('keydown', (e) => {
    const box = $('#slash');
    if (!box.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); slashSel += e.key === 'ArrowDown' ? 1 : -1; if (slashSel < 0) slashSel = 0; slashMenu(); return; }
    if (!box.hidden && e.key === 'Tab') { e.preventDefault(); const on = box.querySelector('.on'); if (on) input.value = on.dataset.c + ' '; box.hidden = true; return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!box.hidden) { const on = box.querySelector('.on'); if (on) input.value = on.dataset.c; } submit(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); const ids = meta.modes.map(m => m.id); const now = cur ? cur.mode : meta.settings.orbiterMode; setMode(ids[(ids.indexOf(now) + 1) % ids.length]); }
    else if (e.key === 'Escape') {
      if (!$('#overlay').hidden) return closeOverlay();
      const t = Date.now(); if (t - lastEsc < 500 && cur) { lastEsc = 0; return rewindDialog(); } lastEsc = t;
      if (cur) O.stop(cur.id);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 't') { e.preventDefault(); themePicker(); }
  });
  $('#sendBtn').onclick = () => { if ($('#sendBtn').classList.contains('stop') && cur) O.stop(cur.id); else submit(); };
  $('#newBtn').onclick = newSession;
  $('#modeChip').onclick = modePicker;
  $('#tierChip').onclick = tierPicker;
  $('#folderChip').onclick = changeFolder;
  $('#paneBtn').onclick = () => { document.body.classList.toggle('pane-off'); try { localStorage.setItem('orbiterPaneOff', document.body.classList.contains('pane-off') ? '1' : ''); } catch {} };
  try { if (localStorage.getItem('orbiterPaneOff')) document.body.classList.add('pane-off'); } catch {}
  window.addEventListener('message', (m) => { const d = m.data || {}; if (d.type === 'open_session' && d.session) open(d.session); else if (d.type === 'focus') input.focus(); });
  $('#themeBtn').onclick = themePicker;
  $('#setBtn').onclick = settingsDlg;
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; renderPane(); });
  O.on(onEvent);

  (async () => {
    meta = await O.meta();
    if (PROJECT) project = await O.project(PROJECT);
    applyTheme(meta.settings.orbiterTheme || 'orbit-dark');
    await loadSessions();
    const want = QS.get('session');
    if (want) await open(want); else if (sessions[0]) await open(sessions[0].id); else { paintChips(); emptyState(); renderPane(); }
    window.__orbiterReady = true;
  })();
})();
