// Orbit Remote — the Orbiter frame's bridge: the desktop preload again, with calls going to the parent page
// (which holds the sealed link) over postMessage.
(function () {
  'use strict';
  let n = 0; const waits = new Map(); const handlers = new Map();
  window.addEventListener('message', (e) => {
    const d = e.data; if (!d || d.__orbitRpc !== 1 || e.source !== window.parent) return;
    if (d.kind === 'res') { const w = waits.get(d.id); if (!w) return; waits.delete(d.id); d.ok ? w.resolve(d.v) : w.reject(new Error(d.e)); }
    else if (d.kind === 'evt') { for (const fn of handlers.get(d.ch) || []) { try { fn({}, d.p); } catch (err) { console.error(err); } } }
  });
  const call = (ch, a) => new Promise((resolve, reject) => { const id = ++n; waits.set(id, { resolve, reject }); window.parent.postMessage({ __orbitRpc: 1, kind: 'invoke', id, ch, a }, '*'); });
  const ipcRenderer = {
    invoke: (ch, ...a) => call(ch, a),
    send: (ch, ...a) => { call(ch, a).catch(() => {}); },
    on: (ch, fn) => { if (!handlers.has(ch)) { handlers.set(ch, []); window.parent.postMessage({ __orbitRpc: 1, kind: 'on', ch }, '*'); } handlers.get(ch).push(fn); },
  };
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { window[k] = v; } }, ipcRenderer };
  (function (require, location) {
    /*__PRELOAD__*/
  })((m) => { if (m === 'electron') return electron; throw new Error(m); }, window.location);
  window.addEventListener('unload', () => { try { window.parent.OrbitRemote && window.parent.OrbitRemote._dropFrame(window); } catch {} });
})();
// Phone layout helpers for Orbiter: buttons to slide the sessions list and the task/changes pane in and out.
document.addEventListener('DOMContentLoaded', () => {
  const tb = document.querySelector('.tb'); if (!tb) return;
  const mk = (title, path, cls) => { const b = document.createElement('button'); b.className = 'rm-tbb'; b.title = title; b.innerHTML = `<svg viewBox="0 0 16 16"><path d="${path}"/></svg>`; b.onclick = (e) => { e.stopPropagation(); document.body.classList.toggle(cls); document.body.classList.remove(cls === 'rm-side' ? 'rm-pane' : 'rm-side'); }; return b; };
  tb.insertBefore(mk('Sessions', 'M2.5 4h11M2.5 8h11M2.5 12h11', 'rm-side'), tb.firstChild);
  tb.appendChild(mk('Tasks and changes', 'M3 3.5h10v9H3zM9.5 3.5v9', 'rm-pane'));
  document.addEventListener('click', (e) => { if (e.target.closest('.sess, #newBtn')) setTimeout(() => document.body.classList.remove('rm-side'), 150); else if (!e.target.closest('.side, .pane, .rm-tbb, .overlay, dialog')) document.body.classList.remove('rm-side', 'rm-pane'); });
});
