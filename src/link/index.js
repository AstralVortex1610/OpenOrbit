// Orbit Phone Link — glue between Orbit's settings and the link server + transports.
// Off by default. When off, nothing listens and nothing reaches out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { LinkServer } = require('./server');
const { CloudflareTunnel, Rendezvous, RelayClient } = require('./transports');
const P = require('./proto');

const THIRD_PARTY_HOSTS = /(^|\.)ntfy\.sh$/i;
const REPUBLISH_MS = 6 * 3600 * 1000; // ntfy keeps a note 12 h; refresh well before that

// Where the bundled cloudflared lives: resources/cloudflared in the installed app, build/cloudflared in a checkout.
function findCloudflared(resourcesPath) {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const c = [process.env.ORBIT_CLOUDFLARED, resourcesPath && path.join(resourcesPath, 'cloudflared', exe), path.join(__dirname, '..', '..', 'build', 'cloudflared', `${process.platform}-${process.arch}`, exe)].filter(Boolean);
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

class PhoneLink extends EventEmitter {
  constructor({ store, dir, invoke, info, log, resourcesPath, qr }) {
    super();
    this.store = store; this.log = log || (() => {});
    this.resourcesPath = resourcesPath; this.qr = qr || require('qrcode');
    this.server = new LinkServer({
      dir, log: (m) => this.log(m), invoke, info,
      protect: (s) => (store && store._enc ? 'e:' + store._enc(s) : 'plain:' + s),
      unprotect: (s) => (String(s).startsWith('e:') ? store._dec(String(s).slice(2)) : String(s).replace(/^plain:/, '')),
      routes: () => this.routes(),
    });
    this.server.on('devices', () => this._changed());
    this.server.on('pairing', () => this._changed());
    this.tunnel = null; this.relay = null; this.rz = null;
    this.on_ = false; this.appState = 'online';
  }

  // ---------- settings → running parts ----------
  config(s = this.store.getSettings()) {
    const noThird = !!s.phoneLinkNoThirdParty;
    let mode = ['cloudflare', 'relay', 'off'].includes(s.phoneLinkRemote) ? s.phoneLinkRemote : 'cloudflare';
    if (mode === 'cloudflare' && noThird) mode = 'off';
    const rzServer = String(s.phoneLinkRendezvous || 'https://ntfy.sh').trim().replace(/\/+$/, '');
    let rzHost = ''; try { rzHost = new URL(rzServer).hostname; } catch {}
    const rzAllowed = !!rzHost && !(noThird && THIRD_PARTY_HOSTS.test(rzHost));
    return {
      enabled: !!s.phoneLinkEnabled, lan: s.phoneLinkLan !== false, port: Number(s.phoneLinkPort) || 47821,
      mode, noThird, relayUrl: String(s.phoneLinkRelayUrl || '').trim(), relayToken: s.phoneLinkRelayToken || '',
      // the rendezvous note only matters when the address changes (tunnel); a relay address is fixed
      rendezvous: rzAllowed && mode === 'cloudflare' ? rzServer : '', pairByCode: rzAllowed ? rzServer : '',
    };
  }
  // Settings can change several times in a row; applying them one at a time keeps exactly one tunnel/relay.
  apply(s) {
    const run = () => this._apply(this.store ? this.store.getSettings() : s).catch(e => { this.log('apply: ' + e.message); return this.status(); });
    this._q = (this._q || Promise.resolve()).then(run, run);
    return this._q;
  }
  async _apply(s) {
    const c = this.config(s);
    const key = JSON.stringify(c);
    if (key === this._applied) return this.status();
    this._applied = key;
    await this._stopParts();
    if (!c.enabled) { this.on_ = false; this._changed(); return this.status(); }
    this.on_ = true; this.cfg = c;
    try { await this.server.start({ port: c.port, lan: c.lan }); }
    catch (e) { this.error = e.message; this.log('could not start: ' + e.message); this._changed(); return this.status(); }
    this.error = '';
    if (c.mode === 'cloudflare') {
      this.tunnel = new CloudflareTunnel({ bin: findCloudflared(this.resourcesPath), port: this.server.port, log: (m) => this.log(m), protocol: process.env.ORBIT_CF_PROTOCOL });
      this.tunnel.on('state', () => this._changed());
      this.tunnel.on('url', () => this.publish('tunnel'));
      this.tunnel.start();
    } else if (c.mode === 'relay' && c.relayUrl) {
      this.relay = new RelayClient({ url: c.relayUrl, room: this.server.room, token: c.relayToken, server: this.server, log: (m) => this.log(m) });
      this.relay.on('state', () => this._changed());
      this.relay.start();
    }
    if (c.rendezvous) this.rz = new Rendezvous({ server: c.rendezvous, log: (m) => this.log(m) });
    this._lanKey = JSON.stringify(this.server.lanUrls());
    clearInterval(this._tick);
    this._tick = setInterval(() => this._watch(), 60 * 1000);
    this.publish('start');
    this._changed();
    return this.status();
  }
  async _stopParts() {
    clearInterval(this._tick);
    if (this.tunnel) { this.tunnel.stop(); this.tunnel = null; }
    if (this.relay) { this.relay.stop(); this.relay = null; }
    this.rz = null;
    await this.server.stop('off');
  }
  stop(reason) { const run = () => this._stop(reason); this._q = (this._q || Promise.resolve()).then(run, run); return this._q; }
  async _stop(reason) {
    if (reason && this.on_) { this.server.bye(reason); await this.publish(reason === 'updating' ? 'updating' : 'offline', reason === 'updating' ? 'updating' : 'offline').catch(() => {}); }
    this._applied = null; this.on_ = false;
    await this._stopParts();
  }
  // Network changed (new Wi-Fi, new IP)? Tell paired phones where to look, and refresh the note before ntfy forgets it.
  _watch() {
    const k = JSON.stringify(this.server.lanUrls());
    if (k !== this._lanKey) { this._lanKey = k; this.publish('network'); this._changed(); }
    else if (this.rz && Date.now() - this.rz.last > REPUBLISH_MS) this.publish('refresh');
  }

  routes() {
    const c = this.cfg || this.config();
    const r = { l: this.server.lanUrls() };
    if (this.tunnel && this.tunnel.wsUrl()) r.t = this.tunnel.wsUrl();
    if (c.mode === 'relay' && c.relayUrl) r.r = { u: c.relayUrl, room: this.server.room };
    if (c.rendezvous) r.z = { s: c.rendezvous };
    return r;
  }
  // The sealed "this is where I am" note for each paired phone.
  async publish(why, state) {
    if (state) this.appState = state;
    if (!this.rz || !this.on_) return 0;
    const devs = this.server.deviceSecrets(); if (!devs.length) return 0;
    const n = await this.rz.publish(devs, { v: 1, state: this.appState, ...this.routes(), why });
    this._changed();
    return n;
  }
  // The PC is going to sleep, updating or quitting: say so first, so the phone shows the right banner.
  async announce(state) {
    this.appState = state;
    if (!this.on_) return;
    if (state !== 'online') this.server.bye(state);
    await this.publish(state, state).catch(() => {});
  }

  // ---------- pairing ----------
  async startPairing() {
    if (!this.on_) throw new Error('Turn on Phone Link first.');
    const p = this.server.newPairing();
    this.pairPost = '';
    if (this.cfg.pairByCode) {
      const rz = new Rendezvous({ server: this.cfg.pairByCode, log: (m) => this.log(m) });
      rz.publishOffer(p.offer.c, p.offer).then(() => { this.pairPost = 'ok'; this._changed(); }).catch(e => { this.pairPost = e.message; this._changed(); });
    }
    return this.status();
  }
  cancelPairing() { this.server.cancelPairing(); return this.status(); }
  revoke(id) { const ok = this.server.revoke(id); return { ok, status: this.status() }; }
  rename(id, name) { this.server.rename(id, name); return this.status(); }

  // ---------- what the Settings card shows ----------
  async statusWithQr() {
    const st = this.status();
    if (st.pairing) { try { st.pairing.qr = await this.qr.toDataURL(st.pairing.link, { errorCorrectionLevel: 'M', margin: 1, scale: 6, color: { dark: '#1a1917', light: '#ffffff' } }); } catch {} }
    return st;
  }
  status() {
    const c = this.cfg || this.config();
    const p = this.on_ ? this.server.pairingInfo() : null;
    return {
      on: this.on_, error: this.error || '', port: this.server.port, lan: this.server.lanUrls(), mode: c.mode, noThird: c.noThird,
      tunnel: this.tunnel ? this.tunnel.info() : null, relay: this.relay ? this.relay.info() : null,
      rendezvous: this.rz ? { server: this.cfg.rendezvous, last: this.rz.last, error: this.rz.error } : null,
      pairing: p ? { code: p.code, expires: p.expires, link: p.link, byCode: !!(this.cfg && this.cfg.pairByCode), posted: this.pairPost || '' } : null,
      devices: this.server.devices(), state: this.appState,
    };
  }
  _changed() { clearTimeout(this._ct); this._ct = setTimeout(() => this.emit('status', this.status()), 50); }

  emitEvent(ch, p) { if (this.on_ && this.server.hasPhones()) this.server.emitEvent(ch, p); }
  recentlyActive(ms) { return this.on_ && this.server.recentlyActive(ms); }
}

module.exports = { PhoneLink, findCloudflared };
