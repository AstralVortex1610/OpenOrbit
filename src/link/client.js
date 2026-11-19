// Orbit Phone Link — the phone side of the link (runs in the Orbit Remote WebView; also used by the tests in Node).
// It pairs, finds the laptop (same network first, then your relay or the Cloudflare tunnel, then the sealed
// rendezvous note if the address changed), keeps one sealed session open, queues requests while the laptop
// is away, resends them after a reconnect (the laptop answers each request id once) and replays missed events.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./proto'));
  else root.OrbitLinkClient = factory(root.OrbitProto);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rid = () => P.b64url(P.rand(9));

  class LinkClient {
    constructor(o) {
      this.WS = o.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      this.fetch = o.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.storage = o.storage; // { get(key) -> string|null, set(key, string|null) } (sync or async)
      this.log = o.log || (() => {});
      this.resolveUrl = o.resolveUrl || ((u) => u); // tests map fake tunnel hosts to local ports
      this.device = o.device || { name: 'Phone', model: '' };
      this.lanTimeout = o.lanTimeout || 2500; this.remoteTimeout = o.remoteTimeout || 9000;
      this.state = 'unpaired'; this.detail = ''; this.via = '';
      this.pending = new Map(); // id -> { ch, a, resolve, reject, sent, at }
      this.handlers = new Map(); this.stateFns = new Set(); this.subs = new Set();
      this.last = -1; this.epoch = ''; this.info = null; this.ws = null; this.chan = null; this.stopped = true; this.fails = 0;
    }
    async _get(k) { const v = await this.storage.get(k); return v == null ? null : v; }
    async _set(k, v) { await this.storage.set(k, v); }
    async load() { const s = await this._get('orbit.link'); this.pairing = s ? JSON.parse(s) : null; if (this.pairing) this._setState('offline', 'not connected yet'); return this.pairing; }
    async _save() { await this._set('orbit.link', this.pairing ? JSON.stringify(this.pairing) : null); }
    get paired() { return !!(this.pairing && this.pairing.id); }

    _setState(state, detail) {
      if (state === this.state && detail === this.detail) return;
      this.state = state; this.detail = detail || '';
      for (const f of this.stateFns) { try { f(state, this.detail, this); } catch {} }
    }
    onState(fn) { this.stateFns.add(fn); return () => this.stateFns.delete(fn); }
    on(ch, fn) { if (!this.handlers.has(ch)) this.handlers.set(ch, new Set()); this.handlers.get(ch).add(fn); return () => this.handlers.get(ch).delete(fn); }
    _emit(ch, p) { const hs = this.handlers.get(ch); if (hs) for (const f of hs) { try { f(p); } catch (e) { this.log('handler ' + ch + ': ' + e.message); } } }

    // ---------- sockets ----------
    _open(url, timeout) {
      return new Promise((resolve, reject) => {
        let ws; try { ws = new this.WS(this.resolveUrl(url)); } catch (e) { reject(e); return; }
        ws.binaryType = 'arraybuffer';
        // Every frame lands in an inbox until someone reads it: several can arrive in one go.
        ws._inbox = []; ws._waiter = null; ws._closed = null;
        const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, timeout);
        ws.onopen = () => { clearTimeout(t); resolve(ws); };
        ws.onerror = () => { clearTimeout(t); reject(new Error('unreachable')); };
        ws.onmessage = (e) => { if (ws._waiter) { const w = ws._waiter; ws._waiter = null; w(e); } else ws._inbox.push(e); };
        ws.onclose = (e) => { clearTimeout(t); ws._closed = (e && e.code) || 1006; if (ws._waiter) { const w = ws._waiter; ws._waiter = null; w(null); } reject(new Error('closed ' + ws._closed)); };
      });
    }
    _next(ws, timeout) {
      return new Promise((resolve, reject) => {
        const fail = () => { const err = new Error('closed ' + ws._closed); err.code = ws._closed; reject(err); };
        if (ws._inbox.length) return resolve(new Uint8Array(ws._inbox.shift().data));
        if (ws._closed) return fail();
        const t = setTimeout(() => { ws._waiter = null; reject(new Error('no answer')); }, timeout);
        ws._waiter = (e) => { clearTimeout(t); if (!e) return fail(); resolve(new Uint8Array(e.data)); };
      });
    }
    // Where to look, best first: same network, then the relay, then the tunnel.
    _routes(r) {
      r = r || {}; const out = [];
      for (const u of r.l || []) out.push({ url: u, via: 'lan', lan: true });
      if (r.r && r.r.u && r.r.room) out.push({ url: String(r.r.u).replace(/\/+$/, '') + '/c/' + encodeURIComponent(r.r.room), via: 'relay' });
      if (r.t) out.push({ url: r.t, via: 'tunnel' });
      return out;
    }
    // Same-network addresses race each other (only one will answer); remote routes go in order.
    async _firstOpen(routes, attempt) {
      const lan = routes.filter(x => x.lan), rest = routes.filter(x => !x.lan);
      if (lan.length) {
        const r = await Promise.any(lan.map(x => attempt(x, this.lanTimeout))).catch(e => ({ err: e.errors ? e.errors[e.errors.length - 1] : e }));
        if (r && !r.err) return r;
        if (r && r.err && r.err.fatal) throw r.err;
      }
      let lastErr = null;
      for (const x of rest) { try { return await attempt(x, this.remoteTimeout); } catch (e) { if (e.fatal) throw e; lastErr = e; } }
      throw lastErr || new Error('no route');
    }

    // ---------- pairing ----------
    async lookupCode(code, server) {
      const k = P.codeKeys(code);
      const res = await this.fetch(`${String(server || 'https://ntfy.sh').replace(/\/+$/, '')}/${k.topic}/json?poll=1&since=15m`);
      const txt = await res.text(); let offer = null;
      for (const line of txt.split('\n')) { try { const m = JSON.parse(line); if (m.event === 'message') { const o = P.openNote(m.message, k.key); if (o) offer = o; } } catch {} }
      if (!offer) throw new Error("Couldn't find that code. Check it, or scan the QR code.");
      return { ...offer, c: P.normCode(code) };
    }
    async pair(input) {
      const offer = typeof input === 'string' ? P.parseOffer(input) : input;
      if (!offer) throw new Error("That isn't an Orbit pairing code.");
      const attempt = async (route, timeout) => {
        const ws = await this._open(route.url, timeout);
        try {
          const req = P.pairRequest(offer, this.device);
          ws.send(req.frame);
          const ans = P.openPaired(await this._next(ws, timeout + 4000), offer.k, req.eph.secretKey);
          if (!ans) throw new Error('bad answer');
          if (!ans.ok) { const e = new Error(ans.reason === 'wrong code' ? 'Wrong code.' : ans.reason === 'expired' ? 'That code expired. Make a new one on the laptop.' : `Pairing refused (${ans.reason}).`); e.fatal = true; throw e; }
          return { ans, via: route.via };
        } finally { try { ws.close(); } catch {} }
      };
      let r;
      try { r = await this._firstOpen(this._routes(offer), attempt); }
      catch (e) { if (e.fatal) throw e; throw new Error(e.code === 4429 ? 'Too many tries. Wait a few minutes.' : "Couldn't reach the laptop. Is Phone Link on, and is the laptop awake?"); }
      const a = r.ans;
      this.pairing = { id: a.id, secret: a.secret, laptop: a.laptop, routes: a.routes || {}, rz: { topic: a.rz && a.rz.topic, server: (a.routes && a.routes.z && a.routes.z.s) || '' }, paired: Date.now() };
      await this._save();
      this._setState('offline', 'paired');
      return this.pairing;
    }
    async unpair() { this.stop(); this.pairing = null; await this._save(); this._setState('unpaired'); }

    // ---------- the connection loop ----------
    start() { if (!this.stopped) return; this.stopped = false; this._loop(); }
    stop() { this.stopped = true; clearTimeout(this._wake); const ws = this.ws; this.ws = null; this.chan = null; try { ws && ws.close(); } catch {} }
    kick() { if (this.state !== 'online') { clearTimeout(this._wake); if (this._sleepResolve) this._sleepResolve(); } } // network back / app in front: try now
    async _loop() {
      while (!this.stopped && this.paired) {
        try { await this._connectOnce(); this.fails = 0; await this._run(); }
        catch (e) {
          if (e.revoked) { this.pairing = null; await this._save(); this._setState('revoked', 'This phone was unlinked on the laptop. Pair it again.'); for (const p of this.pending.values()) p.reject(new Error('unpaired')); this.pending.clear(); return; }
          this.log('connect: ' + e.message);
        }
        if (this.stopped) return;
        this.fails++;
        const wait = Math.min(30000, 1000 * Math.pow(2, Math.min(this.fails - 1, 5)));
        await new Promise(r => { this._sleepResolve = r; this._wake = setTimeout(r, wait); });
        this._expireQueue();
      }
    }
    async _connectOnce() {
      if (this.state !== 'online') this._setState('connecting', this.detail);
      const dev = { id: this.pairing.id, secret: this.pairing.secret };
      const attempt = async (route, timeout) => {
        const ws = await this._open(route.url, timeout);
        try {
          const hs = P.hello(dev, { last: this.last, ep: this.epoch });
          ws.send(hs.frame);
          let f;
          try { f = await this._next(ws, timeout + 3000); }
          catch (e) { if (e.code === 4401) { const er = new Error('revoked'); er.fatal = true; er.revoked = true; throw er; } throw e; }
          const w = P.openWelcome(f, dev, hs);
          if (!w) throw new Error('bad welcome');
          return { ws, chan: w.chan, welcome: w.welcome, via: route.via, url: route.url };
        } catch (e) { try { ws.close(); } catch {} throw e; }
      };
      let r;
      try { r = await this._firstOpen(this._routes(this.pairing.routes), attempt); }
      catch (e) {
        if (e.revoked) throw e;
        // Not where we last saw it: read the sealed note the laptop left on the rendezvous topic.
        const note = await this.readNote().catch(() => null);
        if (note && note.routes) {
          const changed = JSON.stringify(note.routes) !== JSON.stringify(this.pairing.routes);
          if (changed) { this.pairing.routes = note.routes; await this._save(); }
          if (note.state === 'sleeping' || note.state === 'updating' || note.state === 'offline') { this._setState(note.state, note.at ? new Date(note.at).toISOString() : ''); throw new Error('laptop ' + note.state); }
          if (changed) { r = await this._firstOpen(this._routes(note.routes), attempt).catch(err => { if (err.revoked) throw err; return null; }); }
        }
        if (!r) {
          const b = this.lastBye; // the laptop said goodbye a moment ago (updating, going to sleep): keep saying so
          if (b && Date.now() - b.at < 5 * 60 * 1000 && b.reason !== 'off') this._setState(b.reason === 'updating' ? 'updating' : b.reason === 'sleeping' ? 'sleeping' : 'offline', b.reason);
          else this._setState('offline', 'Laptop offline');
          throw e;
        }
      }
      this.ws = r.ws; this.chan = r.chan; this.via = r.via; this.epochSeen = r.welcome.ep;
      if (r.welcome.ep !== this.epoch) this.epoch = r.welcome.ep;
      // remember the route that worked, first in line next time
      if (r.via === 'lan') { const l = (this.pairing.routes.l || []).filter(u => u !== r.url); this.pairing.routes.l = [r.url, ...l]; this._save(); }
      this.lastBye = null;
      this._setState('online', r.via);
    }
    async readNote() {
      const p = this.pairing; if (!p || !p.rz || !p.rz.topic || !this.fetch) return null;
      const server = (p.routes && p.routes.z && p.routes.z.s) || p.rz.server; if (!server) return null;
      const keys = P.deviceKeys(P.unb64(p.secret));
      const res = await this.fetch(`${server.replace(/\/+$/, '')}/${keys.rzTopic}/json?poll=1&since=12h`);
      const txt = await res.text(); let best = null;
      for (const line of txt.split('\n')) { try { const m = JSON.parse(line); if (m.event !== 'message') continue; const o = P.openNote(m.message, keys.rzKey); if (o && (!best || o.at > best.at)) best = o; } catch {} }
      if (!best) return null;
      const { v, state, why, at, ...routes } = best;
      return { state, at, why, routes };
    }
    _run() {
      return new Promise((resolve, reject) => {
        const ws = this.ws; let lastIn = Date.now();
        const ping = setInterval(() => {
          if (Date.now() - lastIn > 50000) { try { ws.close(); } catch {} return; }
          this._send({ t: 'ping' });
        }, 20000);
        ws.onmessage = (e) => {
          lastIn = Date.now();
          let m; try { m = this.chan.unpack(new Uint8Array(e.data)); } catch (err) { this.log('bad frame: ' + err.message); try { ws.close(); } catch {} return; }
          if (m) this._in(m);
        };
        ws.onclose = (e) => {
          clearInterval(ping); if (this.ws === ws) { this.ws = null; this.chan = null; }
          if ((e && e.code === 4401) || this._revokedBye) { this._revokedBye = false; const er = new Error('revoked'); er.revoked = true; reject(er); return; }
          if (!['sleeping', 'updating', 'revoked'].includes(this.state)) this._setState('connecting', 'reconnecting');
          resolve();
        };
        ws.onerror = () => {};
        const early = ws._inbox || []; ws._inbox = [];
        for (const e of early) ws.onmessage(e);
        if (ws._closed) { ws.onclose({ code: ws._closed }); return; }
        for (const ch of this.subs) this._send({ t: 'sub', ch, on: true });
        for (const [id, p] of this.pending) this._send({ t: 'req', id, ch: p.ch, a: p.a }); // resend: answered once by the laptop
      });
    }
    _send(obj) { if (!this.ws || !this.chan || this.ws.readyState !== 1) return false; for (const f of this.chan.pack(obj)) this.ws.send(f); return true; }
    _in(m) {
      if (m.t === 'res') { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.ok) p.resolve(m.v); else { const e = new Error(m.e || 'failed'); e.cancelled = !!m.cancelled; p.reject(e); } this._emit('link:queue', this.pending.size); return; }
      if (m.t === 'evt') { if (m.s) this.last = m.s; this._emit(m.ch, m.p); return; }
      if (m.t === 'info') { this.info = m.info; this._emit('link:info', m.info); return; }
      if (m.t === 'resync') { this.last = m.s; this.epoch = m.ep; this._emit('link:resync', m); return; }
      if (m.t === 'bye') { if (m.reason === 'revoked') { this._revokedBye = true; return; } this.lastBye = { reason: m.reason, at: Date.now() }; this._setState(m.reason === 'updating' ? 'updating' : m.reason === 'sleeping' ? 'sleeping' : 'offline', m.reason); return; }
      if (m.t === 'ping') { this._send({ t: 'pong' }); return; }
    }
    _expireQueue() {
      const now = Date.now();
      for (const [id, p] of this.pending) if (!p.sent && now - p.at > 10 * 60 * 1000) { this.pending.delete(id); p.reject(new Error('Laptop offline')); }
    }

    // ---------- the API the UI uses ----------
    invoke(ch, args) {
      return new Promise((resolve, reject) => {
        const id = rid();
        const p = { ch, a: args || [], resolve, reject, at: Date.now(), sent: false };
        this.pending.set(id, p);
        p.sent = this._send({ t: 'req', id, ch, a: p.a });
        this._emit('link:queue', this.pending.size);
        p.id = id;
      });
    }
    // Cancel a request: dropped from the queue if it never left, otherwise the laptop stops waiting on it.
    cancelLast(ch) { let last = null; for (const [id, p] of this.pending) if (!ch || p.ch === ch) last = id; if (last) this.cancel(last); return last; }
    cancel(id) { const p = this.pending.get(id); if (!p) return false; this.pending.delete(id); this._send({ t: 'cancel', id }); const e = new Error('cancelled'); e.cancelled = true; p.reject(e); this._emit('link:queue', this.pending.size); return true; }
    queued() { return [...this.pending.entries()].map(([id, p]) => ({ id, ch: p.ch, at: p.at })); }
    subscribe(ch, on) { if (on) this.subs.add(ch); else this.subs.delete(ch); this._send({ t: 'sub', ch, on: !!on }); }
  }
  return { LinkClient };
});
