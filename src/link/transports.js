// Orbit Phone Link — ways for a phone on another network to reach this PC. All of them carry only the
// sealed frames from proto.js; none of them is trusted with anything.
//   CloudflareTunnel : a Cloudflare quick tunnel (trycloudflare.com) run by the bundled cloudflared. No account.
//   Rendezvous       : posts a sealed "here is my laptop now" note to an ntfy topic only paired phones can find.
//   RelayClient      : an outbound connection to your own relay (relay/ in this repo), multiplexing phones over it.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const P = require('./proto');

// Electron's network stack when available (system proxy + Windows certificates), like the updater.
function netFetch(url, opts) {
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') return net.fetch(url, opts).catch(() => fetch(url, opts)); } catch {}
  return fetch(url, opts);
}

class CloudflareTunnel extends EventEmitter {
  constructor({ bin, port, log, protocol }) {
    super(); this.bin = bin; this.port = port; this.log = log || (() => {}); this.protocol = protocol || 'http2';
    this.state = 'off'; this.url = ''; this.error = ''; this.fails = 0; this.child = null; this.stopped = true;
  }
  start() {
    this.stopped = false; this._spawn();
    clearInterval(this._health); this._health = setInterval(() => this._check(), 2 * 60 * 1000);
  }
  _set(state, extra) { Object.assign(this, { state }, extra || {}); this.emit('state', this.info()); }
  info() { return { state: this.state, url: this.url, error: this.error }; }
  _spawn() {
    if (this.stopped) return;
    if (!this.bin) { this._set('error', { error: 'cloudflared is missing from this build' }); return; }
    this._set('starting', { url: '', error: '' });
    let child;
    try {
      child = spawn(this.bin, ['tunnel', '--no-autoupdate', '--protocol', this.protocol, '--url', `http://127.0.0.1:${this.port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { this._set('error', { error: e.message }); return this._retry(); }
    this.child = child;
    let buf = '';
    const onData = (d) => {
      buf = (buf + d.toString()).slice(-8000);
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && m[0] !== this.url) { this.url = m[0]; }
      if (this.url && /Registered tunnel connection/.test(buf) && this.state !== 'up') {
        this.fails = 0; this._set('up', { error: '' }); this.log(`tunnel up: ${this.url}`); this.emit('url', this.wsUrl());
      }
      const err = buf.match(/ERR ([^\n]{0,160})/); if (err && this.state !== 'up') this.error = err[1];
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', (e) => { this.error = e.message; });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.log(`cloudflared exited (${code})`);
      this._set('down', { url: '', error: this.error || `cloudflared stopped (${code})` }); this.emit('url', '');
      this._retry();
    });
  }
  _retry() { const wait = [3, 10, 30, 60, 120][Math.min(this.fails++, 4)] * 1000; clearTimeout(this._t); this._t = setTimeout(() => this._spawn(), wait); }
  wsUrl() { return this.url ? this.url.replace(/^https:/, 'wss:') + '/link' : ''; }
  // Quick tunnels sometimes die quietly on Cloudflare's side; a health check through the tunnel catches that.
  async _check() {
    if (this.state !== 'up' || !this.url) return;
    try { const r = await netFetch(this.url + '/health', { signal: AbortSignal.timeout(15000) }); if (r.ok) { this.miss = 0; return; } } catch {}
    if (++this.miss >= 3) { this.miss = 0; this.log('tunnel unreachable, restarting it'); this.restart(); }
  }
  restart() { const c = this.child; this.child = null; try { c && c.kill(); } catch {} this.fails = 0; this._spawn(); }
  stop() { this.stopped = true; clearTimeout(this._t); clearInterval(this._health); const c = this.child; this.child = null; try { c && c.kill(); } catch {} this._set('off', { url: '' }); }
}

class Rendezvous {
  constructor({ server, log, fetchImpl }) { this.server = String(server || 'https://ntfy.sh').replace(/\/+$/, ''); this.log = log || (() => {}); this.fetch = fetchImpl || netFetch; this.last = 0; this.error = ''; }
  async post(topic, sealed) {
    const r = await this.fetch(`${this.server}/${topic}`, { method: 'POST', body: sealed, headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`rendezvous answered ${r.status}`);
  }
  // One sealed note per paired phone, on a topic derived from that phone's own secret.
  async publish(devices, note) {
    let ok = 0;
    for (const d of devices) {
      const k = P.deviceKeys(P.unb64(d.secret));
      try { await this.post(k.rzTopic, P.sealNote({ ...note, at: Date.now() }, k.rzKey)); ok++; } catch (e) { this.error = e.message; this.log('rendezvous: ' + e.message); }
    }
    if (ok) { this.last = Date.now(); this.error = ''; }
    return ok;
  }
  async publishOffer(code, offer) {
    const k = P.codeKeys(code);
    const { c, ...rest } = offer; // the code itself never goes out
    await this.post(k.topic, P.sealNote(rest, k.key));
  }
}

// Relay framing: [op 1][conn id 4][payload]. op 1 = a phone connected (payload: JSON from the relay),
// 2 = data, 3 = closed. The relay sees only ops, ids and sealed payloads.
const OP = { OPEN: 1, DATA: 2, CLOSE: 3 };
function relayFrame(op, id, payload) { const p = payload ? new Uint8Array(payload) : new Uint8Array(0); const b = new Uint8Array(5 + p.length); b[0] = op; b[1] = (id >>> 24) & 255; b[2] = (id >>> 16) & 255; b[3] = (id >>> 8) & 255; b[4] = id & 255; b.set(p, 5); return b; }
// A close carries the code the phone should see (4401 = revoked, 4429 = slow down...).
function closePayload(code, why) { const r = new TextEncoder().encode(String(why || '').slice(0, 60)); const b = new Uint8Array(2 + r.length); const c = code >= 1000 && code < 5000 ? code : 1000; b[0] = c >> 8; b[1] = c & 255; b.set(r, 2); return b; }
function relayParse(b) { b = new Uint8Array(b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b); return { op: b[0], id: ((b[1] << 24) >>> 0) + (b[2] << 16) + (b[3] << 8) + b[4], payload: b.subarray(5) }; }

class RelayClient extends EventEmitter {
  constructor({ url, room, token, server, log }) {
    super(); this.url = String(url || '').replace(/\/+$/, ''); this.room = room; this.token = token || ''; this.server = server; this.log = log || (() => {});
    this.state = 'off'; this.error = ''; this.conns = new Map(); this.fails = 0; this.stopped = true;
  }
  info() { return { state: this.state, error: this.error, url: this.url }; }
  _set(state, error) { this.state = state; if (error !== undefined) this.error = error; this.emit('state', this.info()); }
  start() { this.stopped = false; this._open(); }
  _open() {
    if (this.stopped) return;
    if (!/^wss?:\/\//.test(this.url)) { this._set('error', 'Relay address must start with wss://'); return; }
    const WebSocket = require('ws');
    this._set('connecting');
    const ws = new WebSocket(`${this.url}/host/${encodeURIComponent(this.room)}`, { headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15000 });
    this.ws = ws;
    ws.on('open', () => { this.fails = 0; this._set('up', ''); this.log('relay connected'); this._ping = setInterval(() => { try { ws.ping(); } catch {} }, 25000); });
    ws.on('message', (data) => this._in(data));
    ws.on('unexpected-response', (_req, res) => { this.error = res.statusCode === 401 ? 'The relay refused the token' : `Relay answered ${res.statusCode}`; });
    ws.on('error', (e) => { if (!this.error) this.error = e.message; });
    ws.on('close', () => {
      clearInterval(this._ping);
      for (const c of this.conns.values()) c.onClose();
      this.conns.clear();
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this._set('down');
      const wait = [2, 5, 15, 30, 60][Math.min(this.fails++, 4)] * 1000;
      clearTimeout(this._t); this._t = setTimeout(() => this._open(), wait);
    });
  }
  _in(data) {
    const f = relayParse(data);
    if (f.op === OP.OPEN) {
      let meta = {}; try { meta = JSON.parse(Buffer.from(f.payload).toString('utf8')); } catch {}
      const id = f.id;
      const c = this.server.attach({
        via: 'relay', ip: 'relay:' + String(meta.ip || '?').slice(0, 60),
        send: (b) => { if (this.ws && this.ws.readyState === 1) this.ws.send(relayFrame(OP.DATA, id, b)); },
        close: (code, why) => { if (this.ws && this.ws.readyState === 1) this.ws.send(relayFrame(OP.CLOSE, id, closePayload(code, why))); const x = this.conns.get(id); this.conns.delete(id); if (x) x.onClose(); },
        backlog: () => (this.ws ? this.ws.bufferedAmount : 0),
      });
      this.conns.set(id, c);
    } else if (f.op === OP.DATA) { const c = this.conns.get(f.id); if (c) c.onFrame(f.payload); }
    else if (f.op === OP.CLOSE) { const c = this.conns.get(f.id); this.conns.delete(f.id); if (c) c.onClose(); }
  }
  stop() { this.stopped = true; clearTimeout(this._t); clearInterval(this._ping); const ws = this.ws; this.ws = null; try { ws && ws.close(); } catch {} for (const c of this.conns.values()) c.onClose(); this.conns.clear(); this._set('off', ''); }
}

module.exports = { CloudflareTunnel, Rendezvous, RelayClient, relayFrame, relayParse, closePayload, OP, netFetch };
