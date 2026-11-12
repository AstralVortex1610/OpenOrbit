// Orbit — Connectors screen and the Osint (beta) screen.
(function () {
  const api = window.orbit;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const A = () => window.OrbitApp;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let S = {}; let status = { mcp: [], api: [] }; let presets = {}; let editingApi = null;

  const LOGOS = {
    google: '<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1A10 10 0 0 0 2 12c0 1.6.4 3.2 1.1 4.6z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z"/></svg>',
    github: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.8V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>',
    notion: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#111" stroke-width="1.6"/><path d="M8 7.5v9M8 7.5l8 9M16 7.5v9" stroke="#111" stroke-width="1.8" fill="none"/></svg>',
    slack: '<svg viewBox="0 0 24 24"><rect x="10" y="2.5" width="4" height="9" rx="2" fill="#36C5F0"/><rect x="12.5" y="10" width="9" height="4" rx="2" fill="#2EB67D"/><rect x="10" y="12.5" width="4" height="9" rx="2" fill="#ECB22E"/><rect x="2.5" y="10" width="9" height="4" rx="2" fill="#E01E5A"/></svg>',
    linear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#5E6AD2"/><path d="M6 13.5 10.5 18M5.5 10l8.5 8.5M7.5 7l9.5 9.5M10.5 5.5l8 8" stroke="#fff" stroke-width="1.4"/></svg>',
    custom: '<svg viewBox="0 0 24 24"><path d="M8 7 3 12l5 5M16 7l5 5-5 5M13.5 4.5l-3 15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    mcp: '<svg viewBox="0 0 24 24"><path d="M4 12.5 11.5 5a2.5 2.5 0 0 1 3.5 3.5L9 14.5M9.5 10 14 5.5A2.5 2.5 0 0 1 17.5 9L11 15.5a1 1 0 0 0 0 1.4l1.3 1.3M15 11.5l-4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };
  const pill = (st) => `<span class="cx-pill ${st}">${{ connected: 'Connected', starting: 'Connecting…', error: 'Error', off: 'Off', stopped: 'Stopped' }[st] || esc(st)}</span>`;

  async function load() {
    [S, status, presets] = await Promise.all([api.getSettings(), api.connectors.status(), api.connectors.presets()]);
    render();
  }

  function render() {
    // Accounts
    $('#cxAccounts').innerHTML = `<div class="cx-tile ${S.googleEmail ? 'on' : ''}"><div class="cx-logo">${LOGOS.google}</div><div class="cx-t"><b>Google</b><small>${S.googleEmail ? `Gmail and Calendar · ${esc(S.googleEmail)}` : 'Gmail and Calendar'}</small></div><button class="ghost sm" data-goto-google>${S.googleEmail ? 'Manage' : 'Connect'}</button></div>`;
    $('[data-goto-google]').onclick = () => { A().show('settings'); setTimeout(() => { const c = $('#googleConnect') || $('#googleDisconnect'); c && c.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 120); };
    // Presets
    const have = new Set((S.apiConnectors || []).map(a => a.name.toLowerCase()));
    $('#cxPresets').innerHTML = Object.entries(presets).map(([k, p]) => `<button class="cx-tile preset ${have.has(p.name.toLowerCase()) ? 'on' : ''}" data-preset="${k}" type="button"><div class="cx-logo">${LOGOS[k] || LOGOS.custom}</div><div class="cx-t"><b>${esc(p.name)}</b><small>${have.has(p.name.toLowerCase()) ? 'Connected' : esc(p.description.split(':')[0])}</small></div><span class="cx-plus">${have.has(p.name.toLowerCase()) ? '✓' : '+'}</span></button>`).join('') +
      `<button class="cx-tile preset" data-preset="" type="button"><div class="cx-logo">${LOGOS.custom}</div><div class="cx-t"><b>Any API</b><small>Base URL and a key</small></div><span class="cx-plus">+</span></button>`;
    $$('[data-preset]').forEach(b => b.onclick = () => openApiForm(b.dataset.preset ? { ...presets[b.dataset.preset], preset: b.dataset.preset } : null));
    // API rows
    $('#cxApis').innerHTML = (S.apiConnectors || []).map(a => `<div class="cx-row" data-api="${a.id}"><div class="cx-logo sm">${LOGOS[a.name.toLowerCase()] || LOGOS.custom}</div><div class="cx-t"><b>${esc(a.name)}</b><small>${esc(a.baseUrl)} · ${a.hasKey ? 'key ' + esc(a.keyPreview) : 'no key'} · tool <code>api_${esc(a.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'))}</code></small></div><label class="toggle mini"><input type="checkbox" ${a.enabled !== false ? 'checked' : ''} data-api-toggle /><span></span></label><button class="link-btn" data-api-edit>Edit</button><button class="link-btn danger" data-api-del>Remove</button></div>`).join('');
    $$('[data-api]').forEach(row => {
      const id = row.dataset.api; const a = S.apiConnectors.find(x => x.id === id);
      $('[data-api-toggle]', row).onchange = (e) => saveApis(S.apiConnectors.map(x => x.id === id ? { ...x, enabled: e.target.checked } : x));
      $('[data-api-edit]', row).onclick = () => openApiForm(a, id);
      $('[data-api-del]', row).onclick = () => { if (confirm(`Remove ${a.name}?`)) saveApis(S.apiConnectors.filter(x => x.id !== id)); };
    });
    // MCP rows
    const st = new Map(status.mcp.map(m => [m.id, m]));
    $('#cxMcp').innerHTML = (S.mcpServers || []).length ? S.mcpServers.map(m => { const x = st.get(m.id) || {}; const state = m.enabled === false ? 'off' : (x.status || 'starting'); return `<div class="cx-row mcp" data-mcp="${m.id}"><div class="cx-logo sm">${LOGOS.mcp}</div><div class="cx-t"><b>${esc(m.name)} ${pill(state)}</b><small>${esc(m.type === 'http' ? m.url : `${m.command} ${m.args || ''}`)}${x.tools ? ` · ${x.tools} tools` : ''}${x.error ? ` · <span class="err">${esc(x.error)}</span>` : ''}</small>${x.toolNames && x.toolNames.length ? `<details><summary>Tools</summary><div class="cx-tools">${x.toolNames.map(t => `<code>${esc(t)}</code>`).join('')}</div></details>` : ''}</div><label class="toggle mini"><input type="checkbox" ${m.enabled !== false ? 'checked' : ''} data-mcp-toggle /><span></span></label><button class="link-btn danger" data-mcp-del>Remove</button></div>`; }).join('')
      : `<div class="cx-empty">No MCP servers yet. Try the official filesystem server: command <code>npx</code>, arguments <code>-y @modelcontextprotocol/server-filesystem C:\\Users\\you\\Documents</code> (needs Node.js), or paste any remote server URL.</div>`;
    $$('[data-mcp]').forEach(row => {
      const id = row.dataset.mcp; const m = S.mcpServers.find(x => x.id === id);
      $('[data-mcp-toggle]', row).onchange = (e) => saveMcp(S.mcpServers.map(x => x.id === id ? { ...x, enabled: e.target.checked } : x));
      $('[data-mcp-del]', row).onclick = () => { if (confirm(`Remove ${m.name}?`)) saveMcp(S.mcpServers.filter(x => x.id !== id)); };
    });
  }

  // keep secrets that are already saved: the store keeps them when we send no new value
  const stripMcp = (list) => list.map(({ envKeys, headerKeys, ...m }) => m);
  const stripApi = (list) => list.map(({ hasKey, keyPreview, ...a }) => a);
  async function saveMcp(list) { const r = await api.connectors.save({ mcpServers: stripMcp(list) }); S = r.settings; status = r.status; render(); }
  async function saveApis(list) { const r = await api.connectors.save({ apiConnectors: stripApi(list) }); S = r.settings; status = r.status; render(); }

  // ----- API form -----
  function openApiForm(p, id) {
    editingApi = id || null;
    $('#cxMcpForm').hidden = true;
    const f = $('#cxApiForm'); f.hidden = false;
    $('#apiFormTitle').textContent = id ? `Edit ${p.name}` : p ? `Connect ${p.name}` : 'Add an API';
    $('#apiName').value = p ? p.name : ''; $('#apiBase').value = p ? p.baseUrl : '';
    $('#apiAuth').value = p ? p.auth || 'bearer' : 'bearer'; $('#apiHeader').value = p ? p.authHeader || '' : '';
    $('#apiKey').value = ''; $('#apiKey').placeholder = id && p.hasKey ? `Saved (${p.keyPreview}). Paste a new one to replace it.` : 'Paste the key';
    $('#apiKeyHint').textContent = p && p.keyHint ? p.keyHint : 'stored encrypted on this laptop';
    $('#apiDesc').value = p ? p.description || '' : '';
    f.dataset.headers = JSON.stringify((p && p.headers) || {});
    authRow(); f.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => (id || p ? $('#apiKey') : $('#apiName')).focus(), 250);
  }
  const authRow = () => { $('#apiHeaderRow').hidden = !['header', 'query'].includes($('#apiAuth').value); };
  $('#apiAuth').onchange = authRow;
  $('#apiCancel').onclick = () => { $('#cxApiForm').hidden = true; };
  $('#apiSave').onclick = async () => {
    const row = { name: $('#apiName').value.trim(), baseUrl: $('#apiBase').value.trim(), auth: $('#apiAuth').value, authHeader: $('#apiHeader').value.trim(), description: $('#apiDesc').value.trim(), headers: JSON.parse($('#cxApiForm').dataset.headers || '{}'), enabled: true };
    if (!row.name || !/^https?:\/\//.test(row.baseUrl)) return A().toast('Add a name and a base URL starting with https://');
    const key = $('#apiKey').value.trim(); if (key) row.apiKey = key;
    const list = (S.apiConnectors || []).slice();
    if (editingApi) { const i = list.findIndex(x => x.id === editingApi); list[i] = { ...list[i], ...row, id: editingApi }; } else list.push(row);
    await saveApis(list); $('#cxApiForm').hidden = true; A().toast(`${row.name} connected. Orbit can use it in chat now.`);
  };

  // ----- MCP form -----
  let mcpType = 'stdio';
  $$('#mcpType button').forEach(b => b.onclick = () => { mcpType = b.dataset.v; $$('#mcpType button').forEach(x => x.classList.toggle('on', x === b)); $$('#cxMcpForm [data-for]').forEach(d => { d.hidden = d.dataset.for !== mcpType; }); });
  $('#cxAddMcp').onclick = () => { $('#cxApiForm').hidden = true; const f = $('#cxMcpForm'); f.hidden = !f.hidden; if (!f.hidden) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#mcpName').focus(); } };
  $('#mcpCancel').onclick = () => { $('#cxMcpForm').hidden = true; };
  const kv = (text, sep) => Object.fromEntries(String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(sep); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null; }).filter(Boolean));
  $('#mcpSave').onclick = async () => {
    const row = { name: $('#mcpName').value.trim(), type: mcpType, enabled: true };
    if (mcpType === 'http') { row.url = $('#mcpUrl').value.trim(); row.headers = kv($('#mcpHeaders').value, ':'); if (!/^https?:\/\//.test(row.url)) return A().toast('Add the server URL (https://…)'); }
    else { row.command = $('#mcpCommand').value.trim(); row.args = $('#mcpArgs').value.trim(); row.env = kv($('#mcpEnv').value, '='); if (!row.command) return A().toast('Add the command that starts the server, e.g. npx'); }
    if (!row.name) return A().toast('Give the server a short name');
    await saveMcp([...(S.mcpServers || []), row]);
    $('#cxMcpForm').hidden = true; for (const id of ['mcpName', 'mcpCommand', 'mcpArgs', 'mcpEnv', 'mcpUrl', 'mcpHeaders']) $('#' + id).value = '';
    A().toast(`Connecting ${row.name}…`);
  };
  $('#cxRestart').onclick = async () => { A().toast('Reconnecting…'); status = await api.connectors.restart(); render(); };
  api.on('connectors:changed', (st) => { status = st; if ($('#view-connectors').classList.contains('active')) render(); });

  // ---------------- Osint ----------------
  const OSINT = [
    { k: 'place', t: 'Where is this photo?', d: 'Metadata, visual clues and reverse search to pin down a place. Then flights there if you want.', p: 'Osint: where was this photo taken? Check metadata first, then the clues in the image and a reverse image search. Give me your best guess with confidence and the clues you used. ', attach: true, ico: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>' },
    { k: 'product', t: 'Find this product cheaper', d: 'Identify the exact item in a photo and compare prices on Amazon.in, Flipkart and more.', p: 'Osint: identify the exact product in this photo, then compare the best current prices on Amazon.in, Flipkart and other Indian stores in a table with links. ', attach: true, ico: '<path d="M4 5h2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h7.6a1.5 1.5 0 0 0 1.5-1.2L20 8H7"/><circle cx="10" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/>' },
    { k: 'domain', t: 'Domain recon', d: 'WHOIS, DNS, subdomains, hosting, tech stack and history for any site.', p: 'Osint: full recon on the domain ', ico: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>' },
    { k: 'org', t: 'Organisation lookup', d: 'Legal entity, registration, leadership, filings, news and official accounts.', p: 'Osint: look up the organisation ', ico: '<path d="M4 20.5V6l8-3 8 3v14.5M9 20.5v-4h6v4M8 9h2M14 9h2M8 12.5h2M14 12.5h2"/>' },
    { k: 'figure', t: 'Public figure brief', d: 'Public role, positions, official accounts and recent coverage. Public figures only.', p: 'Osint: give me a brief on the public figure ', ico: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20.5a7 7 0 0 1 14 0"/>' },
    { k: 'ip', t: 'IP and network', d: 'Who owns an IP, its ASN and network, and roughly where it sits.', p: 'Osint: look up the IP ', ico: '<rect x="3.5" y="4" width="17" height="6" rx="1.5"/><rect x="3.5" y="14" width="17" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>' },
    { k: 'breach', t: 'Am I in a breach?', d: 'Check your own email against known data breaches, with what to do next.', p: 'Osint: check my email in known data breaches: ', ico: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>' },
    { k: 'report', t: 'Export a report', d: 'Turn any Osint run into a cited PDF, Word or slide deck.', p: 'Make a PDF Osint report of what you just found, with sources.', ico: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4M9.5 13h5M9.5 16.5h5"/>' },
  ];
  function renderOsint() {
    $('#osintGrid').innerHTML = OSINT.map((o, i) => `<button class="osint-card" data-o="${i}" type="button" style="--d:${i * 45}ms"><span class="oc-ico"><svg viewBox="0 0 24 24">${o.ico}</svg></span><b>${esc(o.t)}</b><small>${esc(o.d)}</small><span class="oc-go">${o.attach ? 'Pick a photo →' : 'Start →'}</span></button>`).join('');
    $$('[data-o]').forEach(b => b.onclick = () => { const o = OSINT[+b.dataset.o]; A().compose(o.p, !!o.attach); });
  }

  window.addEventListener('orbit-view', (e) => {
    if (e.detail.view === 'connectors') load();
    if (e.detail.view === 'osint') renderOsint();
  });
})();
