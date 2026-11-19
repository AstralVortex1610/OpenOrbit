// Orbit Remote — phone-only pieces around the desktop UI: the pairing screen, the connection banner
// ("Laptop offline", "Laptop is updating"…), queued requests you can cancel, and a "This phone" card in Settings.
(function () {
  'use strict';
  const R = window.OrbitRemote; if (!R) return;
  const C = R.client;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  document.body.classList.add('remote');

  // ---------- toast ----------
  function toast(text) { let t = $('#rmToast'); if (!t) { t = document.createElement('div'); t.id = 'rmToast'; document.body.appendChild(t); } t.textContent = text; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200); }
  window.OrbitRemoteUI = { toast };

  // ---------- connection banner ----------
  const banner = document.createElement('div'); banner.id = 'rmBanner'; banner.setAttribute('role', 'status');
  document.body.appendChild(banner);
  const chip = document.createElement('div'); chip.id = 'rmChip';
  const tb = $('.titlebar'); if (tb) tb.insertBefore(chip, $('.tb-buttons', tb));
  let connectingSince = 0;
  function paintBanner() {
    const st = C.state; const q = C.queued().length; const laptop = esc((C.pairing && C.pairing.laptop && C.pairing.laptop.name) || 'your laptop');
    const queued = q ? `<span class="rm-q">${q} waiting</span><button class="rm-btn" data-act="cancel">Cancel</button>` : '';
    let html = '', kind = '';
    if (st === 'online') { kind = ''; }
    else if (st === 'connecting') { if (!connectingSince) connectingSince = Date.now(); if (Date.now() - connectingSince > 1500) { kind = 'busy'; html = `<i class="rm-dot"></i><span>Connecting to ${laptop}…</span>${queued}`; } }
    else if (st === 'offline') { kind = 'off'; html = `<i class="rm-dot"></i><span><b>Laptop offline.</b> Retrying…</span>${queued}<button class="rm-btn" data-act="retry">Retry</button>`; }
    else if (st === 'sleeping') { kind = 'off'; html = `<i class="rm-dot"></i><span><b>Laptop is asleep.</b> Wake it to carry on.</span>${queued}<button class="rm-btn" data-act="retry">Retry</button>`; }
    else if (st === 'updating') { kind = 'busy'; html = `<i class="rm-dot"></i><span><b>Laptop is updating.</b> Back in a minute.</span>${queued}`; }
    if (st !== 'connecting') connectingSince = 0;
    banner.className = kind ? 'show ' + kind : ''; banner.innerHTML = html;
    const via = { lan: 'same Wi-Fi', tunnel: 'internet', relay: 'your relay' }[C.via] || '';
    chip.className = st === 'online' ? 'on' : ''; chip.innerHTML = st === 'online' ? `<i></i>${laptop}${via ? ' · ' + via : ''}` : '';
    document.body.classList.toggle('rm-offline', st !== 'online');
  }
  banner.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'retry') { C.kick(); toast('Trying again…'); }
    if (a.dataset.act === 'cancel') { let n = 0; for (const r of C.queued()) if (C.cancel(r.id)) n++; toast(n ? `Cancelled ${n} waiting request${n > 1 ? 's' : ''}.` : 'Nothing waiting.'); paintBanner(); }
  });
  C.onState((st) => { paintBanner(); if (st === 'revoked') showGate('This phone was unlinked on the laptop. Pair it again to carry on.'); });
  C.on('link:queue', paintBanner);
  setInterval(paintBanner, 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') C.kick(); });
  window.addEventListener('online', () => C.kick());

  // After the laptop restarts the link, reload what's on screen (events in between weren't kept).
  let firstSync = true;
  C.on('link:resync', () => { if (firstSync) { firstSync = false; return; } try { sessionStorage.setItem('rmView', ($('.rail-btn.active') || {}).dataset?.view || 'home'); } catch {} location.reload(); });
  C.on('link:info', (info) => { if (info && info.assistantName) { window.OrbitAssistantName = info.assistantName; document.title = info.assistantName; } });
  try { const v = sessionStorage.getItem('rmView'); if (v) { sessionStorage.removeItem('rmView'); setTimeout(() => { const b = $(`.rail-btn[data-view="${v}"]`); if (b) b.click(); }, 300); } } catch {}

  // ---------- attachments: any file (images go in as pictures, others are sent to the laptop first) ----------
  const fi = $('#fileInput');
  if (fi) {
    fi.setAttribute('accept', '*/*');
    fi.addEventListener('change', async (e) => {
      const files = [...fi.files].filter(f => !f.type.startsWith('image/'));
      if (!files.length) return; // images: the desktop code handles them
      const input = $('#input');
      for (const f of files) {
        toast(`Sending ${f.name} to the laptop…`);
        try {
          const r = await C.invoke('link:upload', [{ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }]);
          input.value = (input.value ? input.value + '\n' : '') + `(File from my phone, saved on the laptop at: ${r.path})`;
          input.dispatchEvent(new Event('input')); toast(`${f.name} is on the laptop.`);
        } catch (err) { toast(`Couldn't send ${f.name}: ${err.message}`); }
      }
      fi.value = '';
    }, true);
  }

  // ---------- Settings: "This phone" ----------
  function phoneCard() {
    const page = $('#view-settings .page'); if (!page || $('#rmCard')) return;
    const card = document.createElement('div'); card.className = 'card'; card.id = 'rmCard';
    page.insertBefore(card, page.firstElementChild && page.firstElementChild.nextElementSibling);
    const paint = () => {
      const p = C.pairing || {}; const lap = (p.laptop && p.laptop.name) || 'your laptop';
      card.innerHTML = `<h3>This phone</h3><p class="muted">Paired with <b>${esc(lap)}</b>${p.paired ? ` since ${new Date(p.paired).toLocaleDateString()}` : ''}. Everything runs on the laptop; this phone only shows it. No API keys are kept here.</p>
        <p class="muted sm">Connection: ${C.state === 'online' ? `connected via ${esc({ lan: 'the same Wi-Fi', tunnel: 'the internet (Cloudflare tunnel)', relay: 'your relay' }[C.via] || C.via)}` : esc(C.state)}. Spoken replies use this phone's voice; the mic records here and the laptop turns it into text.</p>
        <div class="row"><button class="ghost danger-t" id="rmUnpair" type="button">Unpair this phone</button></div>`;
      $('#rmUnpair', card).onclick = async () => { if (!confirm('Unpair this phone? You can pair again with a new code from the laptop.')) return; await C.unpair(); location.reload(); };
    };
    paint(); C.onState(paint);
  }
  phoneCard();

  // ---------- pairing screen ----------
  let scanStop = null;
  function showGate(msg) {
    document.body.classList.add('rm-gated');
    let g = $('#rmGate');
    if (!g) {
      g = document.createElement('div'); g.id = 'rmGate';
      g.innerHTML = `<div class="rg-in">
        <img src="mark.png" class="rg-logo" alt="" />
        <h1>Orbit Remote</h1>
        <p class="rg-sub">Use Orbit on your laptop from this phone. On the laptop, open <b>Settings → Phone Link</b>, turn it on and press <b>Pair a phone</b>.</p>
        <p class="rg-msg" id="rgMsg"></p>
        <button class="primary rg-big" id="rgScan" type="button">Scan the QR code</button>
        <div class="rg-cam" id="rgCam" hidden><video id="rgVideo" playsinline muted></video><canvas id="rgCanvas" hidden></canvas><button class="ghost sm" id="rgCamStop" type="button">Stop camera</button></div>
        <div class="rg-or">or type the code</div>
        <div class="rg-row"><input id="rgCode" placeholder="XXXX-XXXX" maxlength="9" autocapitalize="characters" autocomplete="off" spellcheck="false" /><button class="primary" id="rgCodeGo" type="button">Pair</button></div>
        <details class="rg-adv"><summary>More ways</summary>
          <label>Paste the pairing link from the laptop<textarea id="rgLink" rows="3" placeholder="orbitremote://pair#…"></textarea></label>
          <button class="ghost" id="rgLinkGo" type="button">Pair with link</button>
          <label>Code lookup server (ntfy)<input id="rgServer" value="https://ntfy.sh" autocomplete="off" spellcheck="false" /></label>
        </details>
      </div>`;
      document.body.appendChild(g);
      $('#rgScan').onclick = startScan; $('#rgCamStop').onclick = stopScan;
      $('#rgCodeGo').onclick = async () => { const code = $('#rgCode').value; if (OrbitProto.normCode(code).length !== 8) return say('The code has 8 letters and numbers, like ABCD-2345.'); await doPair(async () => C.pair(await C.lookupCode(code, $('#rgServer').value.trim()))); };
      $('#rgLinkGo').onclick = () => doPair(() => C.pair($('#rgLink').value));
      $('#rgCode').addEventListener('input', (e) => { const v = OrbitProto.normCode(e.target.value); e.target.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v; });
    }
    say(msg || '');
  }
  function say(t, ok) { const m = $('#rgMsg'); if (m) { m.textContent = t; m.className = 'rg-msg' + (ok ? ' ok' : ''); } }
  async function doPair(fn) {
    say('Pairing…', true);
    try { await fn(); stopScan(); say('Paired. Opening…', true); setTimeout(() => location.reload(), 400); }
    catch (e) { say(e.message || String(e)); }
  }
  async function startScan() {
    const cam = $('#rgCam'); cam.hidden = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      const v = $('#rgVideo'); v.srcObject = stream; await v.play();
      const cv = $('#rgCanvas'); const ctx = cv.getContext('2d', { willReadFrequently: true });
      const det = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
      let alive = true; scanStop = () => { alive = false; stream.getTracks().forEach(t => t.stop()); };
      const tick = async () => {
        if (!alive) return;
        let text = null;
        try {
          if (det) { const r = await det.detect(v); if (r[0]) text = r[0].rawValue; }
          else if (window.jsQR && v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; ctx.drawImage(v, 0, 0); const img = ctx.getImageData(0, 0, cv.width, cv.height); const r = jsQR(img.data, img.width, img.height); if (r) text = r.data; }
        } catch {}
        if (text && OrbitProto.parseOffer(text)) { scanStop(); return doPair(() => C.pair(text)); }
        setTimeout(tick, 200);
      };
      tick();
    } catch (e) { cam.hidden = true; say("Couldn't open the camera (" + e.message + '). Type the code instead.'); }
  }
  function stopScan() { if (scanStop) scanStop(); scanStop = null; const c = $('#rgCam'); if (c) c.hidden = true; }

  // A pairing link opened from outside (the Android app passes orbitremote:// links here).
  window.OrbitRemotePairLink = (link) => { if (!C.paired) { showGate(); doPair(() => C.pair(link)); } };

  C.load().then(() => { if (!C.paired) showGate(); paintBanner(); if (window.OrbitRemoteDeepLink) window.OrbitRemotePairLink(window.OrbitRemoteDeepLink); });
})();
