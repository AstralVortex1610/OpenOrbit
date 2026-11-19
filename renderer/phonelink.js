// Orbit — Settings → Phone Link: turn it on, pair a phone with a QR code, see and revoke paired phones.
(() => {
  const api = window.orbit; if (!api || !api.phoneLink) return;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (t) => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
  let st = null, settings = null, timer = null;

  async function loadSettings() { settings = await api.getSettings(); paintForm(); }
  function paintForm() {
    if (!settings) return;
    $('#plOn').checked = !!settings.phoneLinkEnabled;
    $('#plLan').checked = settings.phoneLinkLan !== false;
    $('#plRemote').value = settings.phoneLinkRemote || 'cloudflare';
    $('#plRelayUrl').value = settings.phoneLinkRelayUrl || '';
    $('#plRelayToken').value = '';
    $('#plRelayTokenState').textContent = settings.has_phoneLinkRelayToken ? `Saved and encrypted (${settings.phoneLinkRelayTokenPreview}).` : '';
    $('#plNoThird').checked = !!settings.phoneLinkNoThirdParty;
    $('#plRz').value = settings.phoneLinkRendezvous || 'https://ntfy.sh';
    $('#plPort').value = settings.phoneLinkPort || 47821;
    $('#plBody').hidden = !settings.phoneLinkEnabled;
    paintRemote();
  }
  function paintRemote() {
    const noThird = $('#plNoThird').checked;
    const cf = $('#plRemote').querySelector('option[value=cloudflare]');
    cf.disabled = noThird;
    if (noThird && $('#plRemote').value === 'cloudflare') $('#plRemote').value = 'off';
    $('#plRelayBox').hidden = $('#plRemote').value !== 'relay';
  }
  async function save(patch) { settings = await api.saveSettings(patch); paintForm(); setTimeout(refresh, 400); }

  function dot(state) { return `<i class="pl-dot ${state === 'up' || state === true ? 'ok' : state === 'starting' || state === 'connecting' ? 'busy' : state === 'error' || state === 'down' ? 'bad' : ''}"></i>`; }
  function paint() {
    if (!st) return;
    const r = [];
    if (st.error) r.push(`<div class="pl-route">${dot('error')}<span>Couldn't start: ${esc(st.error)}</span></div>`);
    if (st.on) {
      r.push(`<div class="pl-route">${dot(st.lan.length ? 'up' : '')}<span><b>Same network</b> ${st.lan.length ? esc(st.lan.map(u => u.replace(/^ws:\/\//, '').replace(/\/link$/, '')).join(', ')) : (settings && settings.phoneLinkLan === false ? 'off' : 'no network found')}</span></div>`);
      if (st.mode === 'cloudflare' && st.tunnel) r.push(`<div class="pl-route">${dot(st.tunnel.state)}<span><b>Other networks</b> Cloudflare tunnel ${st.tunnel.state === 'up' ? 'ready' : esc(st.tunnel.state)}${st.tunnel.error && st.tunnel.state !== 'up' ? ` (${esc(st.tunnel.error)})` : ''}</span></div>`);
      else if (st.mode === 'relay') r.push(`<div class="pl-route">${dot(st.relay ? st.relay.state : 'error')}<span><b>Other networks</b> ${st.relay ? `your relay ${st.relay.state === 'up' ? 'connected' : esc(st.relay.state)}${st.relay.error ? ` (${esc(st.relay.error)})` : ''}` : 'add your relay address below'}</span></div>`);
      else r.push(`<div class="pl-route">${dot('')}<span><b>Other networks</b> off${st.noThird ? ' (third-party services are turned off)' : ''}</span></div>`);
    }
    $('#plRoutes').innerHTML = r.join('');
    const p = st.pairing;
    $('#plQr').hidden = !p; $('#plPairBtn').style.display = p ? 'none' : '';
    if (p) {
      if (p.qr) $('#plQrImg').src = p.qr;
      $('#plCode').textContent = p.code;
      const left = Math.max(0, Math.round((p.expires - Date.now()) / 1000));
      $('#plExpires').textContent = left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.${p.byCode ? '' : ' Short codes need the rendezvous server; scan the QR instead.'}` : 'Expired.';
    }
    const devs = st.devices || [];
    $('#plDevices').innerHTML = devs.length ? devs.map(d => `<div class="pl-dev">${dot(d.online)}<div class="pl-dev-t"><b>${esc(d.name)}</b><span class="muted sm">${esc(d.model || '')}${d.model ? ' · ' : ''}${d.online ? `connected${d.via ? ' via ' + esc(d.via) : ''}` : `last seen ${ago(d.lastSeen)}`} · paired ${new Date(d.created).toLocaleDateString()}</span></div><button class="ghost sm danger-t" data-revoke="${esc(d.id)}" type="button">Revoke</button></div>`).join('') : '<p class="muted sm">No phones yet.</p>';
    document.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { if (!confirm('Revoke this phone? It is disconnected right away and has to pair again.')) return; st = await api.phoneLink.revoke(b.dataset.revoke); paint(); });
  }
  async function refresh() { st = await api.phoneLink.status(); paint(); clearInterval(timer); if (st.pairing) timer = setInterval(() => { if (st.pairing && st.pairing.expires < Date.now()) refresh(); else paint(); }, 1000); }

  $('#plOn').onchange = () => save({ phoneLinkEnabled: $('#plOn').checked });
  $('#plNoThird').onchange = paintRemote; $('#plRemote').onchange = paintRemote;
  $('#plSave').onclick = async () => {
    const patch = { phoneLinkLan: $('#plLan').checked, phoneLinkRemote: $('#plRemote').value, phoneLinkRelayUrl: $('#plRelayUrl').value.trim(), phoneLinkNoThirdParty: $('#plNoThird').checked, phoneLinkRendezvous: $('#plRz').value.trim() || 'https://ntfy.sh', phoneLinkPort: Number($('#plPort').value) || 47821 };
    const tok = $('#plRelayToken').value.trim(); if (tok) patch.phoneLinkRelayToken = tok;
    await save(patch); $('#plSaved').textContent = 'Saved.'; setTimeout(() => ($('#plSaved').textContent = ''), 2000);
  };
  $('#plPairBtn').onclick = async () => { $('#plPairBtn').disabled = true; try { st = await api.phoneLink.pair(); paint(); refresh(); } catch (e) { alert(e.message); } $('#plPairBtn').disabled = false; };
  $('#plCancel').onclick = async () => { await api.phoneLink.cancel(); refresh(); };
  $('#plCopyLink').onclick = async () => { if (st && st.pairing) { await navigator.clipboard.writeText(st.pairing.link).catch(() => {}); $('#plCopyLink').textContent = 'Copied'; setTimeout(() => ($('#plCopyLink').textContent = 'Copy pairing link'), 1500); } };
  api.on('phoneLink:status', (s) => { if (s.pairing) refresh(); else { st = s; paint(); } });
  api.on('settings:changed', loadSettings);
  document.addEventListener('click', (e) => { if (e.target.closest('[data-view=settings]')) { loadSettings(); refresh(); } });
  loadSettings(); refresh();
})();
