// Orbit Remote — makes the desktop renderer run on the phone. The desktop preload (src/preload.js, pasted in
// below by remote/build.js) is run against a stand-in for Electron's ipcRenderer that sends every call to
// the laptop over the sealed Phone Link session. So window.orbit is the same API as on the desktop,
// and every feature the desktop UI has works here, executed on the laptop.
(function () {
  'use strict';
  const A = window.OrbitAndroid || null; // the Android app's bridge (Keystore storage, voice, downloads)
  const storage = A ? { get: (k) => A.getItem(k), set: (k, v) => (v == null ? A.removeItem(k) : A.setItem(k, v)) }
    : { get: (k) => localStorage.getItem(k), set: (k, v) => (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v)) };
  const deviceName = () => { try { if (A && A.deviceName) return A.deviceName(); } catch {} const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/); return m ? m[1].replace(/ Build.*/, '') : 'Phone'; };
  const client = new OrbitLinkClient.LinkClient({ storage, device: { name: deviceName(), model: deviceName() }, log: (m) => console.log('[link]', m) });

  // Calls that mean "show me this file" become a download to the phone.
  async function download(arg) {
    const f = await client.invoke('link:file', [arg]);
    const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    if (A && A.saveFile) { const r = A.saveFile(f.name, f.mime, OrbitProto.b64(bytes)); return r || 'saved'; }
    const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
    const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return '';
  }
  const LOCAL = {
    'file:open': (p) => download(p), 'file:saveAs': (p) => download(p).then(() => ({ ok: true })), 'file:reveal': (p) => download(p).then(() => true),
    'projects:openFile': (id, name) => download({ project: id, name }).then(() => true),
    'orbiter:openPath': (p) => download(p).catch(e => e.message),
    'win:minimize': () => null, 'win:maximize': () => null, 'win:close': () => null,
    'orbiter:pickFolder': () => { const p = prompt('Folder on the laptop (full path):'); return p ? p.trim() : null; },
    'computer:start': () => { client.subscribe('computer', true); return client.invoke('computer:start', []); },
    'computer:stop': () => { client.subscribe('computer', false); return client.invoke('computer:stop', []); },
  };
  function invoke(ch, args) { return LOCAL[ch] ? Promise.resolve().then(() => LOCAL[ch](...args)) : client.invoke(ch, args); }

  const R = window.OrbitRemote = { client, invoke, download, storage, android: A,
    on: (ch, fn) => client.on(ch, fn) };

  // Run the real desktop preload against our stand-in Electron.
  function runPreload(win, loc) {
    const ipc = {
      invoke: (ch, ...a) => invoke(ch, a),
      send: (ch, ...a) => { invoke(ch, a).catch(() => {}); },
      on: (ch, fn) => R.on(ch, (p) => fn({}, p)),
    };
    const electron = { contextBridge: { exposeInMainWorld: (k, v) => { win[k] = v; } }, ipcRenderer: ipc };
    const req = (m) => { if (m === 'electron') return electron; throw new Error('not on the phone: ' + m); };
    (function (require, location) {
    /*__PRELOAD__*/
    })(req, loc);
  }
  runPreload(window, window.location);
  if (window.orbit) delete window.orbit.phoneLink; // managed on the laptop only

  // Orbiter runs in an iframe; it gets the same bridge through postMessage (no shared origin needed).
  window.addEventListener('message', async (e) => {
    const d = e.data; if (!d || d.__orbitRpc !== 1 || !e.source) return;
    if (d.kind === 'invoke') {
      try { e.source.postMessage({ __orbitRpc: 1, kind: 'res', id: d.id, ok: true, v: await invoke(d.ch, d.a || []) }, '*'); }
      catch (err) { e.source.postMessage({ __orbitRpc: 1, kind: 'res', id: d.id, ok: false, e: err.message }, '*'); }
    } else if (d.kind === 'on') {
      const src = e.source; const off = R.on(d.ch, (p) => { if (src.closed) { off(); return; } try { src.postMessage({ __orbitRpc: 1, kind: 'evt', ch: d.ch, p }, '*'); } catch { off(); } });
      (R._frameSubs = R._frameSubs || []).push({ src, off });
    }
  });
  R._dropFrame = (src) => { R._frameSubs = (R._frameSubs || []).filter(s => { if (s.src === src) { s.off(); return false; } return true; }); };

  // The phone has its own voice and no live-call engine: these stand in for the desktop ones.
  const speakState = { on: false };
  window.OrbitVoice = {
    engine: 'phone', device: 'phone', ready: true, windows: false, rtf: 0, firstMs: 0,
    get speaking() { try { return A && A.isSpeaking ? A.isSpeaking() : (window.speechSynthesis && speechSynthesis.speaking) || false; } catch { return false; } },
    async say(text) {
      const clean = String(text || '').replace(/```[\s\S]*?```/g, ' code block ').replace(/[#*_`>|]/g, '').replace(/https?:\/\/\S+/g, 'link').slice(0, 3000);
      if (A && A.speak) { A.speak(clean); return true; }
      if (window.speechSynthesis) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(clean)); return true; }
      return false;
    },
    stopSay() { try { if (A && A.stopSpeaking) A.stopSpeaking(); else if (window.speechSynthesis) speechSynthesis.cancel(); } catch {} },
    ensure: async () => true, unload() {}, setVoice() {}, setWinVoice() {}, setPhononVoice() {}, setPauseMs() {}, onVoice() {},
    onStatus: () => () => {}, winVoiceList: async () => [],
  };
  window.OrbitLive = { on: false, start: async () => { if (window.OrbitRemoteUI) OrbitRemoteUI.toast('Live calls run on the laptop. Use the mic for voice messages here.'); } };

  client.load().then(() => { if (client.paired) client.start(); });
})();
