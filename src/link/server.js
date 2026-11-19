// Orbit Phone Link — the link server inside Orbit's main process.
// Phones pair once (QR or short code), then every connection, whichever way it arrives (LAN socket,
// Cloudflare tunnel, self-hosted relay), goes through the same sealed handshake and channel (proto.js).
// The server never trusts the route: a frame that doesn't open with a paired phone's keys is dropped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const P = require('./proto');
const { nacl } = P;

const PAIR_TTL = 5 * 60 * 1000;
const PAIR_TRIES = 5; // wrong codes before the code is thrown away
const RING = 1500; // events kept for phones that reconnect
const MAX_DEVICES = 8;

class RateLimit {
  constructor(max, windowMs) { this.max = max; this.win = windowMs; this.m = new Map(); }
  hit(key) {
    const now = Date.now(); const a = (this.m.get(key) || []).filter(t => now - t < this.win); a.push(now); this.m.set(key, a);
    if (this.m.size > 5000) this.m.clear();
    return a.length <= this.max;
  }
}

class LinkServer extends EventEmitter {
  constructor(o) {
    super();
    this.dir = o.dir; this.file = path.join(o.dir, 'phone-link.json');
    this.protect = o.protect || ((s) => 'plain:' + s);
    this.unprotect = o.unprotect || ((s) => String(s).replace(/^plain:/, ''));
    this.invoke = o.invoke; // async (channel, args, ctx) => value
    this.info = o.info || (() => ({}));
    this.log = o.log || (() => {});
    this.routes = o.routes || (() => ({})); // what goes in a QR: lan urls, tunnel, relay, rendezvous
    this.conns = new Set();
    this.epoch = P.b64url(P.rand(9));
    this.seq = 0; this.ring = [];
    this.pairing = null;
    this.pairLimit = new RateLimit(5, 10 * 60 * 1000); // per address
    this.pairLimitAll = new RateLimit(20, 60 * 1000); // everyone together
    this.helloLimit = new RateLimit(30, 60 * 1000);
    this.seenHello = new Map();
    this.lastActivity = 0;
    this.server = null; this.port = 0;
    this._load();
  }

  // ---------- persistent state: the PC's pairing key and the paired phones (secrets protected at rest) ----------
  _load() {
    let d = {}; try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    if (!d.key || !d.key.pub) { const kp = nacl.box.keyPair(); d.key = { pub: P.b64(kp.publicKey), sec: this.protect(P.b64(kp.secretKey)) }; }
    if (!d.room) d.room = P.b64url(P.rand(16));
    d.devices = Array.isArray(d.devices) ? d.devices : [];
    this.state = d; this._save();
  }
  _save() { try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 1)); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { this.log('save failed: ' + e.message); } }
  get room() { return this.state.room; }
  get laptopPub() { return this.state.key.pub; }
  _laptopSecret() { return P.unb64(this.unprotect(this.state.key.sec)); }
  _devSecrets() { return this.state.devices.map(d => ({ id: d.id, secret: this.unprotect(d.secret) })); }
  devices() {
    return this.state.devices.map(d => ({ id: d.id, name: d.name, model: d.model, created: d.created, lastSeen: d.lastSeen, via: d.via || '', online: [...this.conns].some(c => c.device && c.device.id === d.id) }));
  }
  deviceSecrets() { return this._devSecrets(); } // for the rendezvous publisher (stays in the main process)

  // ---------- listening ----------
  async start({ port = 47821, lan = true } = {}) {
    if (this.server) return this.port;
    const host = lan ? '0.0.0.0' : '127.0.0.1';
    const { WebSocketServer } = require('ws');
    for (let p = port, tries = 0; tries < 12; p = (tries === 10 ? 0 : p + 1), tries++) {
      const srv = http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(req.url === '/health' ? 'ok' : 'not found'); });
      const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
      srv.on('upgrade', (req, sock, head) => {
        if (!/^\/link(\?|$)/.test(req.url || '')) { sock.destroy(); return; }
        wss.handleUpgrade(req, sock, head, (ws) => this._wsConn(ws, req));
      });
      try {
        await new Promise((res, rej) => { srv.once('error', rej); srv.listen(p, host, () => { srv.off('error', rej); res(); }); });
        this.server = srv; this.wss = wss; this.port = srv.address().port; this.lan = lan;
        this.log(`listening on ${host}:${this.port}`);
        this._pinger = setInterval(() => this._ping(), 25000);
        return this.port;
      } catch (e) { try { srv.close(); } catch {} if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
    }
    throw new Error('no free port for Phone Link');
  }
  async stop(reason) {
    clearInterval(this._pinger);
    // events that happen while the link is down aren't kept, so phones must reload rather than replay
    this.epoch = P.b64url(P.rand(9)); this.ring = [];
    for (const c of [...this.conns]) { if (reason && c.chan) this._send(c, { t: 'bye', reason }); c.close(1001, reason || 'stopping'); }
    this.conns.clear();
    if (this.server) { const s = this.server; this.server = null; await new Promise(r => s.close(() => r())); }
    if (this.wss) { try { this.wss.close(); } catch {} this.wss = null; }
  }
  lanUrls() {
    if (!this.server || !this.lan) return [];
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.internal || a.family !== 'IPv4' && a.family !== 4) continue;
        if (/^169\.254\./.test(a.address)) continue; // link-local: never reachable from a phone
        if (/vEthernet|WSL|docker|VirtualBox|VMware|Hyper-V/i.test(name)) continue;
        out.push(`ws://${a.address}:${this.port}/link`);
      }
    }
    return out.slice(0, 4);
  }

  _wsConn(ws, req) {
    const fromLoop = /^(127\.|::1|::ffff:127\.)/.test(req.socket.remoteAddress || '');
    const via = fromLoop && req.headers['cf-connecting-ip'] ? 'tunnel' : fromLoop && req.headers['x-orbit-via'] ? String(req.headers['x-orbit-via']) : 'lan';
    const ip = (fromLoop && req.headers['cf-connecting-ip']) || req.socket.remoteAddress || '?';
    const conn = this.attach({
      via, ip,
      send: (b) => { if (ws.readyState === 1) ws.send(b, { binary: true }); },
      close: (code, why) => { try { ws.close(code || 1000, String(why || '').slice(0, 100)); } catch {} },
      backlog: () => ws.bufferedAmount,
    });
    ws.on('message', (data, isBinary) => conn.onFrame(isBinary ? data : Buffer.from(String(data))));
    ws.on('close', () => conn.onClose());
    ws.on('error', () => {});
    ws.on('pong', () => { conn.alive = true; });
    conn.ping = () => { try { ws.ping(); } catch {} };
  }
  _ping() {
    for (const c of this.conns) {
      if (c.alive === false) { c.close(4408, 'timeout'); continue; }
      c.alive = false;
      if (c.ping) c.ping(); else if (c.chan) this._send(c, { t: 'ping' });
    }
  }

  // Any duplex (WebSocket, relay sub-channel, test pipe) becomes a link connection.
  attach(io) {
    const c = { ...io, device: null, chan: null, alive: true, subs: new Set(), lastFrameAt: 0, born: Date.now() };
    c.onFrame = (b) => this._frame(c, b).catch(e => { this.log(`frame error (${c.via}): ${e.message}`); c.close(4400, 'protocol'); });
    c.onClose = () => { this.conns.delete(c); clearTimeout(c.timer); if (c.device) this._changed(); };
    c.timer = setTimeout(() => { if (!c.chan) c.close(4408, 'handshake timeout'); }, 20000);
    this.conns.add(c);
    return c;
  }

  async _frame(c, b) {
    b = new Uint8Array(b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b);
    if (c.chan) {
      let m;
      try { m = c.chan.unpack(b); } catch (e) { this.log(`dropping ${c.via} connection: ${e.message}`); c.close(4400, 'bad frame'); return; }
      c.alive = true;
      if (m) await this._msg(c, m);
      return;
    }
    if (b[0] === P.T.PAIR) return this._pair(c, b);
    if (b[0] === P.T.HELLO) return this._hello(c, b);
    c.close(4400, 'protocol');
  }

  // ---------- pairing ----------
  newPairing() {
    this.pairing = { code: P.newCode(), expires: Date.now() + PAIR_TTL, tries: 0 };
    this.emit('pairing', this.pairingInfo());
    return this.pairingInfo();
  }
  cancelPairing() { this.pairing = null; this.emit('pairing', null); }
  pairingInfo() {
    const p = this.pairing; if (!p || Date.now() > p.expires) return null;
    const offer = { v: P.V, k: this.laptopPub, c: p.code, h: String(this.info().laptop || os.hostname()).slice(0, 40), ...this.routes() };
    return { code: P.showCode(p.code), expires: p.expires, offer, link: P.offerLink(offer) };
  }
  async _pair(c, b) {
    if (!this.pairLimit.hit(c.ip) || !this.pairLimitAll.hit('all')) { c.close(4429, 'slow down'); return; }
    const p = this.pairing;
    const req = P.openPairRequest(b, this._laptopSecret());
    if (!req) { c.close(4400, 'bad pairing request'); return; }
    const fail = (reason) => { c.send(P.pairedFrame(req.phonePub, this._laptopSecret(), { ok: false, reason })); setTimeout(() => c.close(4403, 'pairing failed'), 200); };
    if (!p || Date.now() > p.expires) return fail('expired');
    if (!P.same(P.utf8(P.normCode(req.body.c)), P.utf8(p.code))) {
      p.tries++;
      if (p.tries >= PAIR_TRIES) { this.pairing = null; this.emit('pairing', null); this.log('pairing code withdrawn after too many wrong tries'); }
      return fail('wrong code');
    }
    if (this.state.devices.length >= MAX_DEVICES) return fail('too many phones');
    this.pairing = null; // one phone per code
    const secret = P.rand(32);
    const dev = { id: P.b64url(P.rand(12)), name: String(req.body.name || 'Phone').slice(0, 40), model: String(req.body.model || '').slice(0, 60), secret: this.protect(P.b64(secret)), created: Date.now(), lastSeen: 0 };
    this.state.devices.push(dev); this._save();
    const keys = P.deviceKeys(secret);
    c.send(P.pairedFrame(req.phonePub, this._laptopSecret(), { ok: true, id: dev.id, secret: P.b64(secret), laptop: { pub: this.laptopPub, name: this.info().laptop || os.hostname() }, routes: this.routes(), rz: { topic: keys.rzTopic } }));
    this.log(`paired ${dev.name}`);
    this.emit('pairing', null); this._changed();
    setTimeout(() => c.close(1000, 'paired'), 300);
  }

  // ---------- hello: a paired phone connects ----------
  async _hello(c, b) {
    if (!this.helloLimit.hit(c.ip)) { c.close(4429, 'slow down'); return; }
    const r = P.openHello(b, this._devSecrets());
    if (!r) { c.close(4401, 'unknown phone'); return; } // revoked or never paired
    if (r.stale) { c.close(4401, 'stale hello'); return; }
    const now = Date.now();
    for (const [k, t] of this.seenHello) if (now - t > 11 * 60 * 1000) this.seenHello.delete(k);
    if (this.seenHello.has(r.hello.n)) { c.close(4401, 'replayed hello'); return; }
    this.seenHello.set(r.hello.n, now);
    const dev = this.state.devices.find(d => d.id === r.device.id);
    const resume = r.hello.ep === this.epoch && Number(r.hello.last) >= 0 && (this.ring.length === 0 || Number(r.hello.last) >= this.ring[0].s - 1);
    const w = P.welcome(r.device, r.hello, { ep: this.epoch, resume });
    c.send(w.frame);
    c.chan = w.chan; c.device = { id: dev.id, name: dev.name }; clearTimeout(c.timer);
    dev.lastSeen = now; dev.via = c.via; this._save();
    this._send(c, { t: 'info', info: this.info() });
    if (resume) { for (const e of this.ring) if (e.s > Number(r.hello.last)) this._send(c, e); }
    else this._send(c, { t: 'resync', ep: this.epoch, s: this.seq });
    this.log(`${dev.name} connected via ${c.via}`);
    this._changed();
  }

  _send(c, obj) { if (!c.chan) return; for (const f of c.chan.pack(obj)) c.send(f); }

  // ---------- messages from a phone ----------
  async _msg(c, m) {
    if (!this.state.devices.some(d => d.id === c.device.id)) { c.close(4401, 'revoked'); return; }
    if (m.t === 'ping') return this._send(c, { t: 'pong' });
    if (m.t === 'pong') return;
    if (m.t === 'sub') { if (m.on) c.subs.add(String(m.ch)); else c.subs.delete(String(m.ch)); this.emit('subs'); return; }
    if (m.t === 'cancel') { const job = this._jobs(c).get(m.id); if (job) { job.cancelled = true; this._send(c, { t: 'res', id: m.id, ok: false, e: 'cancelled', cancelled: true }); } return; }
    if (m.t !== 'req') return;
    this.lastActivity = Date.now();
    const jobs = this._jobs(c);
    const old = jobs.get(m.id);
    if (old) { // a resend after a reconnect: answer from the first run, never run it twice
      if (old.done) this._send(c, old.done);
      else old.waiters.push(c);
      return;
    }
    const job = { at: Date.now(), waiters: [c], done: null, cancelled: false };
    jobs.set(m.id, job);
    if (jobs.size > 400) { for (const [k, j] of jobs) { if (j.done && Date.now() - j.at > 10 * 60 * 1000) jobs.delete(k); } }
    let res;
    try { res = { t: 'res', id: m.id, ok: true, v: await this.invoke(String(m.ch), Array.isArray(m.a) ? m.a : [], { device: c.device, via: c.via }) }; }
    catch (e) { res = { t: 'res', id: m.id, ok: false, e: String((e && e.message) || e).slice(0, 500) }; }
    job.done = res;
    if (job.cancelled) return;
    for (const w of job.waiters) if (this.conns.has(w)) this._send(w, res);
  }
  _jobs(c) { this.jobs = this.jobs || new Map(); if (!this.jobs.has(c.device.id)) this.jobs.set(c.device.id, new Map()); return this.jobs.get(c.device.id); }

  // ---------- events to phones ----------
  hasPhones() { return [...this.conns].some(c => c.chan); }
  subscribed(ch) { return [...this.conns].some(c => c.chan && c.subs.has(ch)); }
  emitEvent(ch, p) {
    if (ch === 'computer:frame') return this._frameOut(p);
    const e = { t: 'evt', s: ++this.seq, ch, p };
    this.ring.push(e); if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    for (const c of this.conns) if (c.chan) this._send(c, e);
  }
  // Live sandbox picture: only to phones that opened the Computer view, at most ~3 frames a second, and
  // never queued behind a slow link (a stale frame is worse than a skipped one).
  _frameOut(p) {
    const now = Date.now();
    for (const c of this.conns) {
      if (!c.chan || !c.subs.has('computer')) continue;
      if (now - c.lastFrameAt < 300 && !(p && p.idle)) continue;
      if (c.backlog && c.backlog() > 512 * 1024) continue;
      c.lastFrameAt = now; this._send(c, { t: 'evt', s: 0, ch: 'computer:frame', p });
    }
  }
  bye(reason) { for (const c of this.conns) if (c.chan) this._send(c, { t: 'bye', reason }); }
  recentlyActive(ms) { return this.hasPhones() && Date.now() - this.lastActivity < ms; }

  // ---------- revoking ----------
  revoke(id) {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter(d => d.id !== id); this._save();
    for (const c of [...this.conns]) if (c.device && c.device.id === id) { this._send(c, { t: 'bye', reason: 'revoked' }); c.close(4401, 'revoked'); this.conns.delete(c); }
    if (this.jobs) this.jobs.delete(id);
    this._changed();
    return before !== this.state.devices.length;
  }
  rename(id, name) { const d = this.state.devices.find(x => x.id === id); if (d) { d.name = String(name || d.name).slice(0, 40); this._save(); this._changed(); } return !!d; }
  _changed() { this.emit('devices', this.devices()); }
}

module.exports = { LinkServer, RateLimit, PAIR_TTL, PAIR_TRIES };
