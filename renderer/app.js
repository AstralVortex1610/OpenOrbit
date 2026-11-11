// Orbit — renderer: chat, tasks, memory, settings, voice.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const api = window.orbit;
  const md = window.renderMarkdown;

  const ICONS = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    ask: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M10 11v6M14 11v6M6 7l1 12.5h10L18 7M9 7V4.5h6V7"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
    repeat: '<svg viewBox="0 0 24 24"><path d="M17 3.5l3 3-3 3M20 6.5H8a4 4 0 0 0-4 4v1M7 20.5l-3-3 3-3M4 17.5h12a4 4 0 0 0 4-4v-1"/></svg>',
  };
  const avatar = () => '<div class="avatar"><img src="mark.png" alt="" /></div>';
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let settings = {};
  let busy = false;
  let turn = null;           // current assistant message element for this run
  const segs = new Map();    // msgId -> { el, text }
  const steps = new Map();   // tool id -> step element
  let attachments = [];
  // Which conversation the chat screen shows: 'main', or a project id.
  let scope = 'main';
  const busyMap = { main: false };
  const pendingCards = new Map(); // approval/question id -> { scope, e } so they survive switching chats

  // ---------- helpers ----------
  function toast(text) {
    const t = $('#toast'); t.textContent = text; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function scrollDown(force) {
    const sc = $('#scroller');
    const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 220;
    if (force || near) sc.scrollTop = sc.scrollHeight;
  }
  function hideWelcome() { $('#welcome').classList.add('gone'); $('.proj-empty')?.remove(); }
  function greeting() {
    const h = new Date().getHours();
    const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    $('#greeting').textContent = settings.userName ? `${part}, ${settings.userName}.` : `${part}.`;
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t || 'dark';
    $$('#themePick .sw').forEach(b => b.classList.toggle('active', b.dataset.theme === (t || 'dark')));
  }
  function setBusy(b) {
    busy = b;
    document.body.classList.toggle('busy', b);
    $('#tbStatus').innerHTML = b ? '<span class="dot"></span>Orbit is working' : '';
    if (!b && turn) { $('.thinking', turn)?.remove(); turn = null; }
  }

  // ---------- message rendering ----------
  function addUser(text, images, via) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg user';
    el.innerHTML = `<div>${images && images.length ? `<div class="imgs">${images.map(u => `<img src="${u}">`).join('')}</div>` : ''}${text ? `<div class="bubble">${escapeHtml(text)}</div>` : ''}${via ? `<div class="via">${via === 'voice' ? 'said on a live call' : `from your phone · ${via}`}</div>` : ''}</div>`;
    $('#messages').appendChild(el);
    scrollDown(true);
  }
  function newTurn(tag) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = `${avatar()}<div class="body">${tag ? `<div class="proactive-tag">${ICONS.bell.replace('<svg', '<svg style="width:12px;height:12px"')}${escapeHtml(tag)}</div>` : ''}<div class="thinking"><i></i><i></i><i></i></div></div>`;
    $('#messages').appendChild(el);
    scrollDown(true);
    return el;
  }
  function ensureTurn() { if (!turn) turn = newTurn(); return turn; }
  function body() { return $('.body', ensureTurn()); }
  function placeBeforeThinking(node) {
    const b = body(); const th = $('.thinking', b);
    th ? b.insertBefore(node, th) : b.appendChild(node);
  }
  function addAssistantStatic(text, tag) {
    const el = newTurn(tag);
    $('.thinking', el).remove();
    const d = document.createElement('div'); d.className = 'md'; d.innerHTML = md(text);
    $('.body', el).appendChild(d);
    wireCode(d); addListen(d, text);
  }
  function addListen(mdEl, text) {
    if (!mdEl || !text || mdEl.querySelector('.listen')) return;
    const b = document.createElement('button');
    b.className = 'listen'; b.title = "Listen in Orbit's voice";
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>';
    b.onclick = async () => {
      if (b.classList.contains('on')) { OrbitVoice.stopSay(); b.classList.remove('on'); return; }
      document.querySelectorAll('.listen.on').forEach(x => x.classList.remove('on'));
      b.classList.add('on', 'loading');
      if (!OrbitVoice.ready) toast("Loading Orbit's voice…");
      await speak(text); b.classList.remove('loading');
      const t = setInterval(() => { if (!OrbitVoice.speaking && !b.classList.contains('loading')) { setTimeout(() => { if (!OrbitVoice.speaking) { b.classList.remove('on'); clearInterval(t); } }, 900); } }, 500);
    };
    mdEl.appendChild(b);
  }
  function wireCode(root) {
    $$('.copy', root).forEach(btn => btn.onclick = () => {
      navigator.clipboard.writeText(btn.closest('.code').querySelector('code').innerText);
      btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  }
  let rafPending = new Set();
  function renderSeg(id) {
    if (rafPending.has(id)) return;
    rafPending.add(id);
    requestAnimationFrame(() => {
      rafPending.delete(id);
      const s = segs.get(id); if (!s) return;
      s.el.innerHTML = md(s.text); s.el.classList.add('cursor');
      scrollDown();
    });
  }
  function currentActivity() {
    const b = body();
    const kids = [...b.children].filter(c => !c.classList.contains('thinking'));
    const last = kids[kids.length - 1];
    if (last && last.classList.contains('activity')) return last;
    const a = document.createElement('div'); a.className = 'activity';
    placeBeforeThinking(a);
    return a;
  }

  // ---------- agent events ----------
  // Lanes: side answers and background tasks each render in their own turn, alongside the main one.
  const laneTurns = new Map();
  const workers = new Map();
  function renderTray() {
    const tray = $('#workerTray');
    const live = [...workers.values()].filter(w => w.state === 'running' || w.state === 'queued');
    tray.innerHTML = live.map(w => `<span class="wchip ${w.state}" title="${escapeHtml(w.step || '')}"><span class="spin"></span><b>${escapeHtml(w.label)}</b><span class="wstep">${escapeHtml(w.state === 'queued' ? 'queued' : (w.step || 'starting'))}</span><button data-stop="${w.id}" title="Stop">×</button></span>`).join('');
    $$('[data-stop]', tray).forEach(b => b.onclick = () => api.stopLane(b.dataset.stop));
    tray.classList.toggle('on', live.length > 0);
  }
  const GLOBAL = new Set(['tasks_changed', 'memory_changed', 'speak', 'panels_changed', 'projects_changed', 'updates_changed']);
  api.on('agent:event', (e) => {
    if (e.type === 'model_switch') { toast(`${e.from} hit a limit, so Orbit switched to ${e.model}.`); return; }
    if (e.type === 'approval' || e.type === 'question') pendingCards.set(e.id, { scope: e.project || 'main', e });
    if (e.type === 'approval_done' || e.type === 'question_done') pendingCards.delete(e.id);
    if (GLOBAL.has(e.type)) { window.dispatchEvent(new CustomEvent('orbit-hub', { detail: e })); if (!['panels_changed', 'projects_changed', 'updates_changed'].includes(e.type)) handleEvent(e); return; }
    if (e.project) {
      if (e.type === 'busy') { busyMap[e.project] = e.busy; window.dispatchEvent(new CustomEvent('orbit-hub', { detail: { type: 'projects_changed' } })); }
      if (scope === e.project) handleEvent(e);
      else if (e.type === 'approval' || e.type === 'question') toast('A project needs your answer. Open it from Projects.');
      return;
    }
    if (e.type === 'busy') busyMap.main = e.busy;
    if (scope !== 'main') {
      if (e.type === 'worker') { workers.set(e.id, { ...(workers.get(e.id) || {}), ...e }); if (['done', 'failed', 'stopped'].includes(e.state)) workers.delete(e.id); renderTray(); }
      if (e.type === 'approval' || e.type === 'question') toast('Orbit needs your answer in Chat.');
      return;
    }
    const lane = e.lane && e.lane !== 'main' ? e.lane : null;
    if (!lane) return handleEvent(e);
    const saved = turn;
    turn = laneTurns.get(lane) || null;
    if (e.type === 'worker') {
      workers.set(e.id, { ...(workers.get(e.id) || {}), ...e });
      if (e.state === 'running' && !turn) turn = newTurn(`${e.via === 'voice' ? 'From your call' : 'Background'} · ${e.label}`);
      if (['done', 'failed', 'stopped'].includes(e.state)) { if (turn) $('.thinking', turn)?.remove(); laneTurns.delete(lane); turn = saved; if (e.state !== 'stopped') setTimeout(() => { workers.delete(e.id); renderTray(); }, 400); else workers.delete(e.id); renderTray(); return; }
      renderTray();
    } else if (e.type === 'user_message') {
      addUser(e.text, e.images, e.via); turn = newTurn(e.worker ? `${e.via === 'voice' ? 'From your call' : 'Background'} · ${e.worker}` : (e.side ? 'Quick answer while I work' : ''));
    } else if (e.type === 'lane_done') {
      if (turn) $('.thinking', turn)?.remove(); laneTurns.delete(lane); turn = saved; return;
    } else handleEvent(e);
    laneTurns.set(lane, turn);
    turn = saved;
  });
  function handleEvent(e) {
    switch (e.type) {
      case 'busy': setBusy(e.busy); break;
      case 'user_message': addUser(e.text, e.images, e.via); turn = newTurn(); break;
      case 'proactive_start': turn = newTurn(e.task.name); break;
      case 'proactive_quiet': if (turn) { turn.remove(); turn = null; } break;
      case 'assistant_start': {
        const d = document.createElement('div'); d.className = 'md';
        placeBeforeThinking(d);
        segs.set(e.id, { el: d, text: '' });
        break;
      }
      case 'delta': { const s = segs.get(e.id); if (s) { s.text += e.text; renderSeg(e.id); } break; }
      case 'assistant_end': {
        let s = segs.get(e.id);
        if (!s) { const d = document.createElement('div'); d.className = 'md'; placeBeforeThinking(d); s = { el: d, text: '' }; segs.set(e.id, s); }
        s.text = e.text; s.el.innerHTML = md(e.text); s.el.classList.remove('cursor'); wireCode(s.el);
        if (!e.interim) addListen(s.el, e.text);
        if (!e.interim) $('.thinking', turn || document.createElement('div'))?.remove();
        scrollDown();
        break;
      }
      case 'assistant_full': {
        if (turn) { $('.thinking', turn)?.remove(); const d = document.createElement('div'); d.className = 'md'; d.innerHTML = md(e.text); $('.body', turn).appendChild(d); wireCode(d); addListen(d, e.text); }
        else addAssistantStatic(e.text, e.proactive);
        scrollDown(true);
        break;
      }
      case 'tool_start': {
        const act = currentActivity();
        const st = document.createElement('div');
        st.className = 'step';
        st.innerHTML = `<span class="ico"><span class="spin"></span></span><span class="lbl">${escapeHtml(e.label)}</span>`;
        const det = document.createElement('div'); det.className = 'step-detail';
        det.textContent = JSON.stringify(e.args, null, 2);
        st.onclick = () => st.classList.toggle('open');
        act.appendChild(st); act.appendChild(det);
        steps.set(e.id, { st, det });
        scrollDown();
        break;
      }
      case 'tool_end': {
        const s = steps.get(e.id); if (!s) break;
        s.st.classList.add(e.ok ? 'ok' : 'err');
        $('.ico', s.st).innerHTML = e.ok ? ICONS.check : ICONS.x;
        s.det.textContent += '\n\n→ ' + e.preview;
        if (e.image) { const img = document.createElement('img'); img.className = 'step-shot'; img.src = e.image; s.det.after(img); }
        break;
      }
      case 'approval': {
        const c = document.createElement('div');
        c.className = 'card-inline'; c.id = 'p-' + e.id;
        c.innerHTML = `<div class="ci-title">${ICONS.shield}${escapeHtml(e.title)}</div><pre>${escapeHtml(e.detail)}</pre>
          <div class="ci-actions"><button class="primary sm" data-a="1">Approve</button><button class="ghost" data-a="0">Don't</button></div>`;
        $$('button', c).forEach(b => b.onclick = () => api.answerApproval(e.id, b.dataset.a === '1'));
        placeBeforeThinking(c); scrollDown(true);
        break;
      }
      case 'approval_done': {
        const c = $('#p-' + e.id); if (!c) break;
        c.classList.add('resolved');
        $('.ci-actions', c).outerHTML = `<div class="ci-done">${e.approved ? 'Approved' : 'Declined'}</div>`;
        break;
      }
      case 'question': {
        const c = document.createElement('div');
        c.className = 'card-inline'; c.id = 'p-' + e.id;
        c.innerHTML = `<div class="ci-title">${ICONS.ask}${escapeHtml(e.question)}</div>
          ${e.choices.length ? `<div class="ci-actions">${e.choices.map(ch => `<button class="choice">${escapeHtml(ch)}</button>`).join('')}</div>` : ''}
          <div class="q-row"><input placeholder="Type your answer…" /><button class="primary sm">Send</button></div>`;
        const submit = (v) => { if (v && v.trim()) api.answerQuestion(e.id, v.trim()); };
        $$('.choice', c).forEach(b => b.onclick = () => submit(b.textContent));
        const inp = $('input', c);
        $('.q-row button', c).onclick = () => submit(inp.value);
        inp.onkeydown = (k) => { if (k.key === 'Enter') submit(inp.value); };
        placeBeforeThinking(c); scrollDown(true); setTimeout(() => inp.focus(), 50);
        break;
      }
      case 'question_done': {
        const c = $('#p-' + e.id); if (!c) break;
        c.classList.add('resolved');
        $$('.ci-actions, .q-row', c).forEach(n => n.remove());
        c.insertAdjacentHTML('beforeend', `<div class="ci-done">You said: ${escapeHtml(e.answer)}</div>`);
        break;
      }
      case 'notice': {
        const n = document.createElement('div'); n.className = 'notice';
        n.innerHTML = `${ICONS.bell}<span><b>${escapeHtml(e.title)}</b> · ${escapeHtml(e.text)}</span>`;
        placeBeforeThinking(n);
        break;
      }
      case 'error': {
        const n = document.createElement('div'); n.className = 'err-line';
        const needsSetup = /Settings/.test(e.message);
        n.innerHTML = `${ICONS.x}<span>${escapeHtml(e.message)} ${needsSetup ? '<button data-go="settings">Open Settings</button>' : ''}</span>`;
        const g = $('[data-go]', n); if (g) g.onclick = () => show('settings');
        placeBeforeThinking(n); $('.thinking', body())?.remove(); scrollDown(true);
        break;
      }
      case 'speak': speak(e.text); break;
      case 'tasks_changed': loadTasks(); break;
      case 'memory_changed': if ($('#view-memory').classList.contains('active')) loadMemory(); break;
    }
  }
  api.on('tasks:changed', loadTasks);
  api.on('ui:focusInput', () => { show('chat'); $('#input').focus(); });

  // ---------- composer ----------
  const input = $('#input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 200) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy && !input.value.trim()) { scope === 'main' ? api.stop() : api.projects.stop(scope); return; }
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    if (scope === 'main') api.send(text, attachments); else api.projects.send(scope, text, attachments);
    input.value = ''; attachments = []; renderAttachments(); autosize();
  });
  $$('#chips .chip').forEach(c => c.onclick = () => { input.value = c.textContent; $('#composer').requestSubmit(); });

  // attachments (paste or pick)
  function addFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = () => { attachments.push({ name: file.name, dataUrl: r.result }); renderAttachments(); };
    r.readAsDataURL(file);
  }
  function renderAttachments() {
    $('#attachments').innerHTML = attachments.map((a, i) => `<div class="att"><img src="${a.dataUrl}"><button data-i="${i}">×</button></div>`).join('');
    $$('#attachments button').forEach(b => b.onclick = () => { attachments.splice(+b.dataset.i, 1); renderAttachments(); });
  }
  $('#attachBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => { [...e.target.files].forEach(addFile); e.target.value = ''; };
  input.addEventListener('paste', (e) => { [...(e.clipboardData?.files || [])].forEach(addFile); });

  // ---------- voice ----------
  let rec = null, chunks = [];
  // auto=true (after "Hey Orbit"): stops by itself once you've finished talking.
  function startVoice({ auto = false, isCancelled = () => false } = {}) {
    return new Promise(async (done) => {
      const btn = $('#micBtn');
      if (rec && rec.state === 'recording') { rec.stop(); return done(); }
      let stream, vadTimer = null, actx = null;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch { toast('Microphone not available.'); return done(); }
      rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        clearInterval(vadTimer); try { actx && actx.close(); } catch {}
        stream.getTracks().forEach(t => t.stop());
        btn.classList.remove('recording');
        if (isCancelled()) return done();
        btn.classList.add('working');
        try {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const text = (await api.transcribe(await blob.arrayBuffer(), 'audio/webm')).trim().replace(/^(hey|okay|hi),?\s+orbit[,.!]?\s*/i, '');
          if (text) { input.value = text; autosize(); $('#composer').requestSubmit(); }
          else toast("I didn't catch that.");
        } catch (err) { toast(String(err.message || err).replace(/^Error invoking remote method[^:]*:\s*/, '')); }
        btn.classList.remove('working');
        done();
      };
      rec.start();
      btn.classList.add('recording');
      if (auto) {
        // Simple voice-activity check: stop after ~1.4 s of quiet once speech started, or 15 s max.
        actx = new AudioContext();
        const an = actx.createAnalyser(); an.fftSize = 1024;
        actx.createMediaStreamSource(stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        let spoke = false, quietSince = Date.now(); const started = Date.now();
        vadTimer = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let sum = 0; for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          if (rms > 0.02) { spoke = true; quietSince = Date.now(); }
          const quiet = Date.now() - quietSince;
          if ((spoke && quiet > 1400) || (!spoke && Date.now() - started > 6000) || Date.now() - started > 15000) { clearInterval(vadTimer); if (rec.state === 'recording') rec.stop(); }
        }, 100);
      }
    });
  }
  $('#micBtn').onclick = () => startVoice();
  $('#liveBtn').onclick = () => startLive();
  async function startLive() {
    if (window.OrbitWake && OrbitWake.on) OrbitWake.pause();
    speechSynthesis.cancel();
    await OrbitLive.start();
  }
  window.addEventListener('orbit-live-ended', () => { if (window.OrbitWake && OrbitWake.on) OrbitWake.resume(); });
  window.addEventListener('orbit-live-needs-setup', () => {
    toast('Live voice needs a Gemini or OpenAI key first.');
    show('settings'); setTimeout(() => $('#liveCard').scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
  });
  // Read aloud in Orbit's own voice; falls back to the Windows voice if it can't load.
  async function speak(text) {
    if (window.OrbitVoice && (await OrbitVoice.say(text))) return;
    if (!('speechSynthesis' in window)) return;
    const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[#*_`>|]/g, '').replace(/https?:\/\/\S+/g, 'link').slice(0, 900);
    const u = new SpeechSynthesisUtterance(clean);
    const v = speechSynthesis.getVoices().find(v => /Natural|Aria|Jenny|Guy|Google UK English/i.test(v.name));
    if (v) u.voice = v;
    u.rate = 1.03;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }

  // ---------- navigation ----------
  function show(view, opts = {}) {
    if (view === 'chat' && opts.scope !== undefined && opts.scope !== scope) openScope(opts.scope);
    const railView = view === 'chat' && scope !== 'main' ? 'projects' : view;
    $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === railView));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    api.ui.scope(view === 'chat' ? scope : 'none');
    window.dispatchEvent(new CustomEvent('orbit-view', { detail: { view, scope } }));
    if (view === 'tasks') loadTasks();
    if (view === 'memory') loadMemory();
    if (view === 'settings') loadSettings();
    if (view === 'chat') setTimeout(() => input.focus(), 50);
  }
  $$('.rail-btn').forEach(b => b.onclick = () => show(b.dataset.view, b.dataset.view === 'chat' ? { scope: 'main' } : {}));

  // ---------- switching conversations (main chat or a project) ----------
  function msgText(m) {
    let text = m.display || (typeof m.content === 'string' ? m.content : ((m.content || []).find(p => p.type === 'text') || {}).text);
    if (text) text = text.replace(/\n\n\(Sent from Live voice[\s\S]*$/, '');
    return text;
  }
  function renderThread(thread) {
    for (const m of thread) {
      if (m.role === 'user') {
        const imgs = Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url) : [];
        addUser(msgText(m), imgs, m.via);
      } else if (m.role === 'assistant' && m.content) addAssistantStatic(m.content, m.proactive || (m.worker ? `Background · ${m.worker}` : ''));
    }
  }
  async function openScope(next) {
    scope = next || 'main';
    $('#messages').innerHTML = ''; segs.clear(); steps.clear(); laneTurns.clear(); turn = null;
    document.body.classList.toggle('in-project', scope !== 'main');
    $('#drawer').classList.remove('open');
    if (scope === 'main') {
      $('#welcome').classList.remove('gone');
      input.placeholder = 'Message Orbit…';
      renderThread(await api.getThread());
    } else {
      $('#welcome').classList.add('gone');
      const p = await api.projects.get(scope);
      if (!p) { scope = 'main'; return openScope('main'); }
      window.dispatchEvent(new CustomEvent('orbit-scope', { detail: p }));
      input.placeholder = `Message Orbit about ${p.name}…`;
      const t = await api.projects.thread(scope);
      if (!t.length) $('#messages').innerHTML = `<div class="proj-empty"><span class="proj-mono big" style="--c:${p.color}">${escapeHtml(p.name.slice(0, 1).toUpperCase())}</span><h2>${escapeHtml(p.name)}</h2><p>${escapeHtml(p.about || 'A space of its own: chat here, and Orbit keeps the brief and files for this project.')}</p></div>`;
      renderThread(t);
    }
    for (const { scope: s, e } of pendingCards.values()) if (s === scope) handleEvent(e);
    setBusy(!!busyMap[scope]);
    if (busyMap[scope]) turn = newTurn();
    scrollDown(true);
    api.ui.scope(scope);
  }
  $$('[data-win]').forEach(b => b.onclick = () => api.win[b.dataset.win]());

  // ---------- tasks ----------
  function describe(t) {
    if (t.kind === 'daily') return `Every day at ${t.time}`;
    if (t.kind === 'weekly') return `Weekly (${(t.days || []).map(d => 'Sun Mon Tue Wed Thu Fri Sat'.split(' ')[d]).join(', ')}) at ${t.time}`;
    if (t.kind === 'interval') return `Every ${t.everyHours} hours`;
    if (t.kind === 'once') return `Once, ${new Date(t.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    return t.kind;
  }
  async function loadTasks() {
    const tasks = await api.getTasks();
    const el = $('#taskList');
    if (!tasks.length) { el.innerHTML = '<div class="empty">No tasks yet. Ask Orbit to remind you of something.</div>'; return; }
    el.innerHTML = tasks.map((t, i) => `
      <div class="task ${t.enabled ? '' : 'off'}" style="animation-delay:${i * 40}ms">
        <div class="t-ico">${t.id === 'morning-brief' ? ICONS.sun : t.kind === 'interval' ? ICONS.repeat : ICONS.clock}</div>
        <div class="t-main">
          <div class="t-name">${escapeHtml(t.name)}</div>
          <div class="t-when">${escapeHtml(describe(t))}${t.lastRun ? ` · last ran ${new Date(t.lastRun).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : ''}</div>
          <div class="t-prompt">${escapeHtml(t.prompt)}</div>
        </div>
        <div class="t-actions">
          <button class="icon-btn" data-run="${t.id}" title="Run now">${ICONS.play}</button>
          <label class="toggle" title="On or off"><input type="checkbox" data-tog="${t.id}" ${t.enabled ? 'checked' : ''}/><span></span></label>
          <button class="icon-btn" data-del="${t.id}" title="Delete">${ICONS.trash}</button>
        </div>
      </div>`).join('');
    $$('[data-run]', el).forEach(b => b.onclick = () => { api.runTask(b.dataset.run); toast('Running now'); show('chat'); });
    $$('[data-tog]', el).forEach(b => b.onchange = async () => { await api.toggleTask(b.dataset.tog, b.checked); loadTasks(); });
    $$('[data-del]', el).forEach(b => b.onclick = async () => { await api.deleteTask(b.dataset.del); loadTasks(); toast('Task deleted'); });
  }

  // ---------- memory ----------
  let memCurrent = null;
  async function loadMemory() {
    const files = await api.listMemory();
    $('#memList').innerHTML = files.map(f => `<button class="mem-item ${f.name === memCurrent ? 'active' : ''}" data-n="${escapeHtml(f.name)}"><span>${escapeHtml(f.name)}</span><span>${new Date(f.updated).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></button>`).join('');
    $$('#memList .mem-item').forEach(b => b.onclick = () => openMem(b.dataset.n));
    if (!memCurrent && files[0]) openMem(files.find(f => f.name === 'USER.md') ? 'USER.md' : files[0].name);
  }
  async function openMem(name) {
    memCurrent = name;
    $('#memName').textContent = name;
    $('#memText').value = (await api.readMemory(name)) || '';
    $('#memText').disabled = false; $('#memSave').disabled = true;
    $$('#memList .mem-item').forEach(b => b.classList.toggle('active', b.dataset.n === name));
  }
  $('#memText').addEventListener('input', () => ($('#memSave').disabled = false));
  $('#memSave').onclick = async () => { await api.writeMemory(memCurrent, $('#memText').value); $('#memSave').disabled = true; toast('Memory saved'); loadMemory(); };
  $('#newMemBtn').onclick = async () => {
    let n = $('#newMemName').value.trim(); if (!n) return;
    if (!n.endsWith('.md')) n += '.md';
    await api.writeMemory(n, `# ${n.replace(/\.md$/, '')}\n`); $('#newMemName').value = '';
    memCurrent = n; await loadMemory(); openMem(n);
  };
  $('#openMemFolder').onclick = () => api.openMemoryFolder();

  // ---------- settings ----------
  const FIELDS = ['orbitVoice', 'orbitStt', 'orbitTts', 'orbitPhononVoice', 'orbitWinVoice', 'orbitPauseMs', 'liveEngine', 'liveGeminiVoice', 'liveOpenaiVoice', 'baseUrl', 'model', 'fastModel', 'voiceModel', 'browserChannel', 'phoneWhen', 'phoneIdleMinutes', 'ntfyServer', 'transcribeModel', 'userName', 'approvalMode', 'dailyTokenCap', 'maxSteps', 'hotkey', 'maxWorkers', 'imageModel', 'imageBaseUrl', 'googleClientId'];
  const TOGGLES = ['autoUpdate', 'talkFirst', 'autoCall', 'orbitGpu', 'wakeOpensLive', 'voiceReplies', 'closeToTray', 'startWithWindows', 'wakeWord', 'ntfyEnabled', 'telegramEnabled'];
  // Edits you haven't saved yet survive any refresh of this screen (a new ntfy topic,
  // Telegram pairing, Google connect...). Before, those refreshes wiped the whole form.
  const dirty = new Set();
  let backupsDirty = false;
  $('#view-settings').addEventListener('input', (e) => { if (e.target.id) dirty.add(e.target.id); if (e.target.closest('#backupList')) backupsDirty = true; });
  $('#view-settings').addEventListener('change', (e) => { if (e.target.id) dirty.add(e.target.id); if (e.target.closest('#backupList')) backupsDirty = true; });
  async function loadSettings() {
    const keep = [...dirty].map(id => { const el = document.getElementById(id); return el && (el.type === 'checkbox' ? [el, 'checked', el.checked] : [el, 'value', el.value]); }).filter(Boolean);
    settings = await api.getSettings();
    FIELDS.forEach(f => { const el = $('#s-' + f); if (!el) return; el.value = settings[f] ?? ''; if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.selectedIndex = 0; });
    TOGGLES.forEach(f => { $('#s-' + f).checked = !!settings[f]; });
    $('#s-apiKey').value = '';
    for (const k of ['googleClientSecret', 'netlifyToken', 'imageApiKey']) { $('#k-' + k).value = ''; $('#k-' + k + 'State').textContent = settings['has_' + k] ? `Saved and encrypted (${settings[k + 'Preview']}).` : ''; }
    $('#googleState').textContent = settings.has_googleRefresh ? `Connected as ${settings.googleEmail || 'your account'}.` : 'Not connected.';
    $('#googleState').style.color = settings.has_googleRefresh ? 'var(--ok)' : '';
    $('#googleDisconnect').style.display = settings.has_googleRefresh ? '' : 'none';
    for (const k of ['liveGeminiKey', 'liveOpenaiKey']) {
      $('#k-' + k).value = '';
      $('#k-' + k + 'State').textContent = settings['has_' + k] ? `Saved and encrypted (${settings[k + 'Preview']}).` : (k === 'liveGeminiKey' && /generativelanguage/.test(settings.baseUrl || '')) || (k === 'liveOpenaiKey' && /api\.openai\.com/.test(settings.baseUrl || '')) ? 'Using your main API key.' : 'No key yet.';
    }
    syncLiveEngine();
    $('#keyState').textContent = settings.hasKey ? `Saved and encrypted on this laptop (${settings.keyPreview}). Paste a new one to replace it.` : 'No key saved yet.';
    const u = await api.getUsage();
    $('#usageNote').textContent = `Used today: ${u.tokensToday.toLocaleString()} tokens. Orbit pauses when it hits the cap.`;
    const info = await api.info();
    $('#appInfo').textContent = `Orbit ${info.version}`;
    applyTheme(settings.theme);
    $('#ntfyTopicShow').textContent = settings.ntfyTopic || '(save to create)';
    $('#ntfyReplyShow').textContent = settings.ntfyTopic ? settings.ntfyTopic + '-reply' : '';
    $('#pairCode').textContent = settings.telegramPairCode || '------';
    $('#s-telegramToken').value = '';
    $('#tgState').textContent = !settings.hasTelegramToken ? 'No bot token yet.' : settings.telegramChatId ? 'Paired with your Telegram. ' : 'Token saved. Waiting for you to send the pairing code to your bot.';
    $('#tgState').style.color = settings.telegramChatId ? 'var(--ok)' : '';
    if (settings.telegramChatId && !$('#unpairTg')) { const b = document.createElement('button'); b.id = 'unpairTg'; b.className = 'link-btn'; b.textContent = 'Unpair'; b.onclick = async () => { await api.phoneUnpairTelegram(); loadSettings(); }; $('#tgState').appendChild(b); }
    if (!backupsDirty) renderBackups(settings.backupModels || []);
    for (const [el, prop, v] of keep) el[prop] = v;
    if (keep.length) syncLiveEngine();
    syncWake();
  }
  // ---------- backup models ----------
  function renderBackups(list) {
    const box = $('#backupList'); box.innerHTML = '';
    list.forEach((b) => addBackupRow(b));
  }
  function addBackupRow(b = {}) {
    const box = $('#backupList');
    const row = document.createElement('div'); row.className = 'backup-row'; row.dataset.id = b.id || '';
    row.innerHTML = `<span class="n"></span><input class="bm-model" list="modelList" placeholder="Model name" /><input class="bm-base" placeholder="Base URL (same as above)" /><input class="bm-key" type="password" autocomplete="off" placeholder="${b.hasKey ? 'Key saved (' + escapeHtml(b.keyPreview) + ')' : 'API key (same as above)'}" /><button type="button" title="Remove">×</button>`;
    row.querySelector('.bm-model').value = b.model || '';
    row.querySelector('.bm-base').value = b.baseUrl || '';
    row.querySelector('button').onclick = () => { row.remove(); backupsDirty = true; numberBackups(); };
    box.appendChild(row); numberBackups();
    return row;
  }
  function numberBackups() { $$('#backupList .backup-row').forEach((r, i) => (r.querySelector('.n').textContent = i + 1)); }
  $('#addBackup').onclick = () => { backupsDirty = true; addBackupRow().querySelector('.bm-model').focus(); };
  function readBackups() {
    return $$('#backupList .backup-row').map(r => ({ id: r.dataset.id || undefined, model: r.querySelector('.bm-model').value.trim(), baseUrl: r.querySelector('.bm-base').value.trim(), apiKey: r.querySelector('.bm-key').value.trim() })).filter(b => b.model);
  }
  // ---------- updates ----------
  function showUpdate(st) {
    if (!st) return;
    const el = $('#updateState'), go = $('#installUpdate');
    el.style.color = st.status === 'error' ? 'var(--danger)' : st.status === 'latest' ? 'var(--ok)' : '';
    el.textContent = st.status === 'checking' ? 'Checking…'
      : st.status === 'latest' ? `You're on the latest version (${st.current}).`
      : st.status === 'available' ? `Orbit ${st.latest} is ready to install (you have ${st.current}).`
      : st.status === 'downloading' ? `Downloading ${st.latest}… ${st.progress || 0}%`
      : st.status === 'installing' ? 'Installing. Orbit will close and reopen in about a minute.'
      : st.status === 'error' ? st.error : '';
    go.style.display = st.status === 'available' || (st.status === 'error' && st.url) ? '' : 'none';
    const bar = $('#updateBar');
    if (st.status === 'available' && !showUpdate.later) { $('#updateBarText').textContent = `Orbit ${st.latest} is out.`; $('#updateBarGo').style.display = ''; bar.classList.add('show'); }
    else if (st.status === 'downloading' && bar.classList.contains('show')) { $('#updateBarText').textContent = `Downloading ${st.latest}… ${st.progress || 0}%`; $('#updateBarGo').style.display = 'none'; }
    else if (st.status === 'installing') { $('#updateBarText').textContent = 'Installing. Orbit reopens in a minute.'; $('#updateBarGo').style.display = 'none'; bar.classList.add('show'); }
    else if (st.status !== 'downloading') bar.classList.remove('show');
  }
  api.on('update:state', showUpdate);
  api.update.state().then(showUpdate);
  $('#checkUpdate').onclick = async () => showUpdate(await api.update.check());
  const doUpdate = async () => { await saveSettings(); showUpdate(await api.update.install()); };
  $('#installUpdate').onclick = doUpdate;
  $('#updateBarGo').onclick = doUpdate;
  $('#updateBarLater').onclick = () => { showUpdate.later = true; $('#updateBar').classList.remove('show'); };
  async function fillWinVoices() {
    const sel = $('#s-orbitWinVoice'); if (!sel || !window.OrbitVoice || sel.dataset.filled) return;
    const list = await OrbitVoice.winVoiceList(); if (!list.length) return;
    sel.dataset.filled = '1';
    for (const v of list) { const o = document.createElement('option'); o.value = v.name; o.textContent = `${v.name.replace(/^Microsoft\s+/, '').replace(/\s+-\s+.*$/, '')} (${v.lang})`; sel.appendChild(o); }
    if (settings && settings.orbitWinVoice) sel.value = settings.orbitWinVoice;
  }
  fillWinVoices();
  function syncLiveEngine() { const v = $('#s-liveEngine').value; $$('.live-eng').forEach(d => (d.style.display = d.dataset.eng === v ? '' : 'none')); }
  $('#s-liveEngine').onchange = syncLiveEngine;
  $('#voicePreview').onclick = async () => {
    await saveSettings();
    const st = $('#voiceState'); st.style.color = '';
    const off = OrbitVoice.onStatus((x) => { if (x.text) st.textContent = x.text; });
    try {
      await OrbitVoice.ensure(); OrbitVoice.setVoice($('#s-orbitVoice').value);
      OrbitVoice.setWinVoice($('#s-orbitWinVoice').value); OrbitVoice.setPhononVoice($('#s-orbitPhononVoice').value);
      st.textContent = OrbitVoice.engine === 'phonon' ? `Ready: Phonon, first sound in ${OrbitVoice.firstMs || '?'} ms, ${OrbitVoice.rtf ? (1 / OrbitVoice.rtf).toFixed(1) + '× real time' : ''}${OrbitVoice.device === 'webgpu' ? ' on your GPU' : ''}.` : OrbitVoice.windows ? `Ready, using the Windows voice${OrbitVoice.rtf > 0.8 ? ' (the natural voice is too slow on this laptop)' : ''}.` : `Ready${OrbitVoice.device === 'webgpu' ? ', using your GPU' : ''}.`; st.style.color = 'var(--ok)';
      OrbitVoice.say(`Hey${settings.userName ? ' ' + settings.userName : ''}! This is how I'll sound. Pretty natural, right?`);
    } catch (e) { st.textContent = `Couldn't load the voice: ${e.message}`; st.style.color = 'var(--danger)'; }
    off();
  };
  // ---------- Voice check: every step out loud and on screen, with a report to copy ----------
  $('#voiceCheck').onclick = async () => {
    await saveSettings();
    const out = $('#voiceCheckOut'); out.innerHTML = '';
    const lines = [`Orbit voice check, ${new Date().toString()}`, `Engine: ${settings.liveEngine || 'orbit'}, speaks: ${settings.orbitTts || 'auto'}, hearing: ${settings.orbitStt || 'moonshine'}, model: ${settings.model || '(none)'}`];
    const row = (ok, title, detail) => { const d = document.createElement('div'); d.className = 'vc-row ' + (ok === null ? 'run' : ok ? 'ok' : 'bad'); d.innerHTML = `<b>${ok === null ? '…' : ok ? '✓' : '✗'}</b> ${escapeHtml(title)}<small>${escapeHtml(detail || '')}</small>`; out.appendChild(d); return d; };
    const done = (d, ok, title, detail) => { d.className = 'vc-row ' + (ok ? 'ok' : 'bad'); d.innerHTML = `<b>${ok ? '✓' : '✗'}</b> ${escapeHtml(title)}<small>${escapeHtml(detail || '')}</small>`; lines.push(`${ok ? 'OK ' : 'FAIL'} ${title}: ${detail || ''}`); };
    // 1. Speakers, with the Windows voice (no download)
    let d = row(null, 'Speakers', 'Saying a test line with the Windows voice…');
    try {
      const n = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().length : 0;
      window.OrbitWinSayNow && OrbitWinSayNow('Voice check. If you can hear this, your speakers work.');
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'audiooutput').length;
      done(d, true, 'Speakers', `Test line played (${n} Windows voices, ${outs} output devices). If you heard nothing, check the volume and output device.`);
    } catch (e) { done(d, false, 'Speakers', e.message); }
    // 2. Microphone level
    d = row(null, 'Microphone', 'Say something now, for 4 seconds…');
    try {
      const ms = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }), new Promise((_, r) => setTimeout(() => r(new Error('no answer from the mic in 15 s')), 15000))]);
      const ac = new AudioContext(); const an = ac.createAnalyser(); ac.createMediaStreamSource(ms).connect(an);
      const buf = new Float32Array(an.fftSize); let peak = 0; const t0 = Date.now();
      while (Date.now() - t0 < 4000) { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; peak = Math.max(peak, Math.sqrt(s / buf.length)); await new Promise(r => setTimeout(r, 50)); }
      ms.getTracks().forEach(t => t.stop()); ac.close();
      const label = ms.getAudioTracks()[0]?.label || 'default mic';
      done(d, peak > 0.01, 'Microphone', peak > 0.01 ? `Heard you on "${label}" (level ${peak.toFixed(3)}).` : `"${label}" is on but silent (level ${peak.toFixed(4)}). Pick another mic in Windows sound settings, or check it isn't muted.`);
    } catch (e) { done(d, false, 'Microphone', `${e.name || ''} ${e.message}. In Windows Settings → Privacy & security → Microphone, turn on "Let desktop apps access your microphone".`); }
    // 3. Orbit's own voice
    d = row(null, 'Orbit voice', 'Loading (first time downloads about 200 MB)…');
    const off = OrbitVoice.onStatus((x) => { if (x.text) d.querySelector('small').textContent = x.text; });
    try {
      const t0 = Date.now(); await OrbitVoice.ensure(); off();
      OrbitVoice.setPhononVoice(settings.orbitPhononVoice || 'Easton');
      await OrbitVoice.say(`Hey${settings.userName ? ' ' + settings.userName : ''}, this is Orbit's own voice.`);
      done(d, true, 'Orbit voice', `${OrbitVoice.engine} on ${OrbitVoice.device}, ready in ${Math.round((Date.now() - t0) / 1000)} s${OrbitVoice.firstMs ? `, first sound ${OrbitVoice.firstMs} ms` : ''}${OrbitVoice.rtf ? `, ${(1 / OrbitVoice.rtf).toFixed(1)}× real time` : ''}.`);
    } catch (e) { off(); done(d, false, 'Orbit voice', e.message); }
    // 4. Brain
    d = row(null, 'Brain (your model)', 'Asking your model to reply…');
    try {
      if (!settings.hasKey || !settings.model) throw new Error('No model set. Calls still work and repeat back what they hear.');
      const r = await api.voice.brainTest();
      const ok = r ? r.ok !== false : true;
      done(d, ok, 'Brain (your model)', ok ? `${settings.model} answered in ${r.ms} ms.` : (r.error || 'no answer'));
    } catch (e) { done(d, false, 'Brain (your model)', e.message); }
    const rep = document.createElement('div'); rep.className = 'row';
    rep.innerHTML = '<button type="button" class="ghost sm">Copy report</button><span class="muted small">Paste it to Hark if anything failed.</span>';
    rep.querySelector('button').onclick = () => { navigator.clipboard.writeText(lines.join('\n')); toast('Voice report copied'); };
    out.appendChild(rep);
  };
  $('#copyTopic').onclick = () => { navigator.clipboard.writeText(settings.ntfyTopic || ''); toast('Topic copied'); };
  $('#newTopic').onclick = async () => { await api.phoneNewTopic(); await loadSettings(); toast('New topic made. Re-subscribe on your phone.'); };
  $('#phoneTest').onclick = async () => { await saveSettings(); $('#phoneResult').textContent = 'Sending…'; const r = await api.phoneTest(); $('#phoneResult').textContent = r.message; $('#phoneResult').style.color = r.ok ? 'var(--ok)' : 'var(--danger)'; };
  api.on('settings:changed', (p) => { loadSettings(); if (p && p.why === 'telegram') toast('Telegram paired'); });

  // ---------- Hey Orbit ----------
  function syncWake() {
    const want = !!(settings && settings.wakeWord);
    if (!window.OrbitWake) return;
    if (want && !OrbitWake.on) { $('#wakeState').textContent = 'Loading the wake word model…'; OrbitWake.start(); }
    if (!want && OrbitWake.on) OrbitWake.stop();
  }
  window.addEventListener('orbit-wake-state', (e) => {
    const d = e.detail;
    $('#wakeState').textContent = d.error ? `Couldn't start: ${d.error}` : d.on ? 'Listening for "Hey Orbit".' : '';
    $('#wakeState').style.color = d.error ? 'var(--danger)' : d.on ? 'var(--ok)' : '';
    document.body.classList.toggle('wake-on', !!d.on);
  });
  let wakeCancelled = false;
  const wakeLive = async () => settings && settings.wakeOpensLive !== false && (await api.live.status()).ready;
  window.addEventListener('orbit-wake', async () => {
    if (OrbitLive.on || await wakeLive()) return; // a confirmed wake opens the live call instead
    if (rec && rec.state === 'recording') return;
    wakeCancelled = false;
    await startVoice({ auto: true, isCancelled: () => wakeCancelled });
    OrbitWake.resume();
  });
  window.addEventListener('orbit-wake-confirm', async () => {
    if (OrbitLive.on) return;
    OrbitWake.pause(); chime(); await api.wakeHeard(); show('chat');
    if (await wakeLive()) startLive();
  });
  window.addEventListener('orbit-wake-cancel', () => { wakeCancelled = true; if (rec && rec.state === 'recording') rec.stop(); });
  function chime() {
    try {
      const c = new AudioContext(); const o = c.createOscillator(); const g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(660, c.currentTime); o.frequency.exponentialRampToValueAtTime(990, c.currentTime + 0.12);
      g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.35);
      o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.4); setTimeout(() => c.close(), 600);
    } catch {}
  }
  $('#preset').onchange = (e) => {
    if (!e.target.value) return;
    $('#s-baseUrl').value = e.target.value; $('#s-model').value = ''; dirty.add('s-baseUrl'); dirty.add('s-model');
    $('#modelList').innerHTML = '';
    $('#modelState').textContent = 'Paste this provider\'s key, then tap List models.';
  };
  $('#listModels').onclick = async () => {
    await saveSettings();
    $('#modelState').textContent = 'Asking the provider…'; $('#modelState').style.color = '';
    const r = await api.listModels();
    if (!r.ok) { $('#modelState').textContent = r.error; $('#modelState').style.color = 'var(--danger)'; return; }
    $('#modelList').innerHTML = r.models.map(m => `<option value="${m.replace(/"/g, '&quot;')}"></option>`).join('');
    $('#modelState').textContent = `${r.models.length} models available. Click the Model box to pick one.`;
    $('#modelState').style.color = 'var(--ok)';
    if (!$('#s-model').value && r.models.length) $('#s-model').focus();
  };
  $$('#themePick .sw').forEach(b => b.onclick = () => { applyTheme(b.dataset.theme); settings.theme = b.dataset.theme; api.saveSettings({ theme: b.dataset.theme }); });
  async function saveSettings() {
    const out = {};
    FIELDS.forEach(f => { const el = $('#s-' + f); if (el) out[f] = el.type === 'number' ? Number(el.value) : el.value.trim(); });
    TOGGLES.forEach(f => (out[f] = $('#s-' + f).checked));
    const key = $('#s-apiKey').value.trim(); if (key) out.apiKey = key;
    out.backupModels = readBackups();
    for (const k of ['liveGeminiKey', 'liveOpenaiKey', 'googleClientSecret', 'netlifyToken', 'imageApiKey']) { const v = $('#k-' + k).value.trim(); if (v) out[k] = v; }
    const prevTts = settings.orbitTts || 'auto', prevStt = settings.orbitStt || 'moonshine';
    settings = await api.saveSettings(out);
    // Switching who speaks (or how Orbit hears) reloads the voice next time it's needed.
    if (window.OrbitVoice && !(window.OrbitLive && OrbitLive.on) && ((settings.orbitTts || 'auto') !== prevTts || (settings.orbitStt || 'moonshine') !== prevStt)) OrbitVoice.unload();
    if (window.OrbitVoice) { OrbitVoice.setPhononVoice(settings.orbitPhononVoice || 'Easton'); OrbitVoice.setWinVoice(settings.orbitWinVoice || ''); OrbitVoice.setPauseMs(Number(settings.orbitPauseMs) || 900); }
    dirty.clear(); backupsDirty = false;
    await loadSettings(); greeting();
  }
  $('#saveSettings').onclick = async () => { await saveSettings(); toast('Settings saved'); };
  $('#googleConnect').onclick = async () => {
    await saveSettings();
    $('#googleState').textContent = 'Finish signing in in your browser…'; $('#googleState').style.color = '';
    const r = await api.googleConnect();
    if (!r.ok) { $('#googleState').textContent = r.error; $('#googleState').style.color = 'var(--danger)'; return; }
    await loadSettings(); toast('Google connected');
  };
  $('#googleDisconnect').onclick = async () => { await api.googleDisconnect(); await loadSettings(); toast('Google disconnected'); };
  $('#testBtn').onclick = async () => {
    await saveSettings();
    $('#testResult').textContent = 'Testing…'; $('#testResult').style.color = '';
    const r = await api.testConnection();
    $('#testResult').textContent = r.message;
    $('#testResult').style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
  };
  $('#clearThread').onclick = async () => {
    if (!confirm('Clear the whole chat history? Memory stays.')) return;
    await api.clearThread(); $('#messages').innerHTML = ''; $('#welcome').classList.remove('gone'); toast('Chat cleared');
  };

  window.OrbitApp = {
    show, openScope, toast, escapeHtml, md, ICONS,
    get scope() { return scope; }, get settings() { return settings; },
    busy: (id) => !!busyMap[id],
    send: (text) => { openScope('main').then(() => { show('chat'); api.send(text, []); }); },
  };

  // ---------- boot ----------
  (async function boot() {
    settings = await api.getSettings();
    applyTheme(settings.theme);
    greeting();
    syncWake();
    renderThread(await api.getThread());
    scrollDown(true);
    if (!settings.hasKey) {
      const el = newTurn(); $('.thinking', el).remove();
      $('.body', el).insertAdjacentHTML('beforeend', `<div class="md"><p>Hi${settings.userName ? ' ' + escapeHtml(settings.userName) : ''}, I'm Orbit. Give me a brain first: add your base URL, API key and model in Settings, and I'm ready.</p></div><div style="margin-top:10px"><button class="primary sm" id="goSetup">Open Settings</button></div>`);
      $('#goSetup').onclick = () => show('settings');
      $('#welcome').classList.remove('gone');
    }
    window.dispatchEvent(new CustomEvent('orbit-ready', { detail: settings }));
    // Orbit comes up by itself: it opens a call and speaks first (Settings → Live voice to turn off).
    setTimeout(() => {
      if (settings.autoCall === false || !window.OrbitLive || OrbitLive.on) return;
      if (document.visibilityState !== 'visible') return; // started hidden in the tray at sign-in
      OrbitLive.start();
    }, 2500);
    // Warm up Orbit's voice quietly once its files are on this laptop, so calls connect right away.
    setTimeout(async () => {
      try {
        if (!window.OrbitVoice || OrbitVoice.ready || !(await api.voice.cached())) return;
        if ((settings.liveEngine || 'orbit') !== 'orbit' && !settings.voiceReplies) return;
        OrbitVoice.ensure().catch(() => {});
      } catch {}
    }, 6000);
  })();
})();
