// Orbit Phone Link — wire protocol, shared by the desktop (Node) and the Orbit Remote phone app (browser/WebView).
//
// Everything that leaves Orbit is sealed here, at the application layer, before it touches a socket, a
// Cloudflare tunnel, a relay or ntfy. TLS on those hops is a bonus, not the protection: Cloudflare and any
// relay terminate TLS and only ever see the sealed bytes below.
//
//   Pairing   (QR)  phone -> PC  [1][phone eph pub 32][nonce 24][box(code, phone name) to the PC's static key]
//                   PC -> phone  [2][nonce 24][box(device id, device secret, routes) to the phone's eph key]
//   Hello            phone -> PC [3][nonce 24][secretbox_helloKey(id, eph pub, nonce, time, last seq)]
//                   PC -> phone  [4][nonce 24][secretbox_helloKey(eph pub, nonce, echo, epoch)]
//   Data     both ways           [5][counter 8][secretbox_dirKey(json)]   nonce = 16 zero bytes + counter
//
//   box/secretbox = NaCl (Curve25519 + XSalsa20-Poly1305, via tweetnacl). helloKey = KDF(device secret).
//   Session keys = KDF(device secret, X25519(eph, eph), both nonces, both eph keys): fresh per connection
//   (forward secrecy), one key per direction, strictly increasing counters (a replayed, dropped or
//   reordered frame fails and the connection is closed). Hellos carry a time and a random nonce the PC
//   remembers, so a recorded hello can't be replayed either (and it couldn't derive the keys anyway).
//   Big messages are split into sealed parts of at most PART bytes, so file chunks and audio are sealed too.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('tweetnacl'));
  else root.OrbitProto = factory(root.nacl);
})(typeof self !== 'undefined' ? self : this, function (nacl) {
  'use strict';
  const V = 1;
  const T = { PAIR: 1, PAIRED: 2, HELLO: 3, WELCOME: 4, DATA: 5 };
  const PART = 96 * 1024; // max plaintext per sealed frame (relays and tunnels like small frames)
  const HELLO_SKEW = 5 * 60 * 1000;
  const te = new TextEncoder(); const td = new TextDecoder();

  const utf8 = (s) => te.encode(String(s));
  const fromUtf8 = (b) => td.decode(b);
  function concat(...arrs) { let n = 0; for (const a of arrs) n += a.length; const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }
  function u8(x) { if (x instanceof Uint8Array) return x; if (x instanceof ArrayBuffer) return new Uint8Array(x); if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength); throw new Error('bytes expected'); }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64(bytes) {
    bytes = u8(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    while (s.length % 4) s += '=';
    const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
  const b64url = (b) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hex = (b) => Array.from(u8(b), x => x.toString(16).padStart(2, '0')).join('');
  const rand = (n) => nacl.randomBytes(n);
  function len4(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
  // Domain-separated key derivation: SHA-512 over length-prefixed parts, first 32 bytes.
  function kdf(label, ...parts) {
    const chunks = [utf8('orbit-link/v1/' + label)];
    for (const p of parts) { const b = typeof p === 'string' ? utf8(p) : u8(p); chunks.push(len4(b.length), b); }
    return nacl.hash(concat(...chunks)).slice(0, 32);
  }
  function same(a, b) { a = u8(a); b = u8(b); if (a.length !== b.length || !a.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

  // ---------- pairing codes ----------
  const CODE_ABC = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
  function newCode() { const r = rand(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ABC[r[i] % CODE_ABC.length]; return s; }
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').slice(0, 8);
  const showCode = (c) => { c = normCode(c); return c.slice(0, 4) + '-' + c.slice(4); };
  // Short-code pairing (no camera): the PC posts its pairing offer, sealed with a key stretched from the code.
  function codeKeys(code) {
    code = normCode(code);
    let k = kdf('pair-code', code); for (let i = 0; i < 20000; i++) k = nacl.hash(k).slice(0, 32);
    return { topic: 'orbp' + hex(kdf('pair-topic', code)).slice(0, 36), key: k };
  }

  // ---------- notes (rendezvous: "this is where my laptop is now") ----------
  function sealNote(obj, key) { const n = rand(24); return b64url(concat(n, nacl.secretbox(utf8(JSON.stringify(obj)), n, key))); }
  function openNote(s, key) { try { const b = unb64(s); const m = nacl.secretbox.open(b.subarray(24), b.subarray(0, 24), key); return m ? JSON.parse(fromUtf8(m)) : null; } catch { return null; } }
  function deviceKeys(secret) { secret = u8(secret); return { hello: kdf('hello', secret), rzTopic: 'orb' + hex(kdf('rz-topic', secret)).slice(0, 36), rzKey: kdf('rz-key', secret) }; }

  // ---------- QR offer ----------
  // orbitremote://pair#<base64url json>. The QR only ever lives on the PC's screen.
  function offerLink(o) { return 'orbitremote://pair#' + b64url(utf8(JSON.stringify(o))); }
  function parseOffer(s) {
    s = String(s || '').trim();
    const m = s.match(/#([A-Za-z0-9_-]{20,})$/) || s.match(/^([A-Za-z0-9_-]{40,})$/);
    if (!m) return null;
    try { const o = JSON.parse(fromUtf8(unb64(m[1]))); return o && o.v === V && o.k && o.c ? o : null; } catch { return null; }
  }

  // ---------- pairing frames ----------
  function pairRequest(offer, info) {
    const eph = nacl.box.keyPair(); const n = rand(24);
    const body = utf8(JSON.stringify({ c: normCode(offer.c), name: String(info.name || 'Phone').slice(0, 40), model: String(info.model || '').slice(0, 60), ts: Date.now() }));
    return { eph, frame: concat([T.PAIR], eph.publicKey, n, nacl.box(body, n, unb64(offer.k), eph.secretKey)) };
  }
  function openPairRequest(frame, laptopSecret) {
    frame = u8(frame); if (frame[0] !== T.PAIR || frame.length < 1 + 32 + 24 + 16) return null;
    const pub = frame.slice(1, 33); const n = frame.subarray(33, 57);
    const m = nacl.box.open(frame.subarray(57), n, pub, u8(laptopSecret));
    if (!m) return null;
    try { return { phonePub: pub, body: JSON.parse(fromUtf8(m)) }; } catch { return null; }
  }
  function pairedFrame(phonePub, laptopSecret, obj) { const n = rand(24); return concat([T.PAIRED], n, nacl.box(utf8(JSON.stringify(obj)), n, u8(phonePub), u8(laptopSecret))); }
  function openPaired(frame, laptopPub, ephSecret) {
    frame = u8(frame); if (frame[0] !== T.PAIRED) return null;
    const m = nacl.box.open(frame.subarray(25), frame.subarray(1, 25), unb64(laptopPub), ephSecret);
    try { return m ? JSON.parse(fromUtf8(m)) : null; } catch { return null; }
  }

  // ---------- hello / welcome ----------
  function hello(dev, extra) {
    const eph = nacl.box.keyPair(); const nc = rand(32); const n = rand(24);
    const body = { v: V, id: dev.id, e: b64(eph.publicKey), n: b64(nc), ts: Date.now(), ...(extra || {}) };
    const key = deviceKeys(unb64(dev.secret)).hello;
    return { eph, nc, frame: concat([T.HELLO], n, nacl.secretbox(utf8(JSON.stringify(body)), n, key)) };
  }
  // devices: [{ id, secret(b64) }]. Trial-decrypts with each paired phone's hello key (a handful at most).
  function openHello(frame, devices, now) {
    frame = u8(frame); if (frame[0] !== T.HELLO || frame.length < 1 + 24 + 16) return null;
    const n = frame.subarray(1, 25); const c = frame.subarray(25);
    for (const d of devices) {
      const key = deviceKeys(unb64(d.secret)).hello;
      const m = nacl.secretbox.open(c, n, key);
      if (!m) continue;
      let h; try { h = JSON.parse(fromUtf8(m)); } catch { return null; }
      if (h.id !== d.id || Math.abs((now || Date.now()) - Number(h.ts)) > HELLO_SKEW) return { device: d, hello: h, stale: true };
      return { device: d, hello: h };
    }
    return null;
  }
  function welcome(dev, h, extra) {
    const eph = nacl.box.keyPair(); const ns = rand(32); const n = rand(24);
    const body = { v: V, e: b64(eph.publicKey), n: b64(ns), echo: h.n, ...(extra || {}) };
    const key = deviceKeys(unb64(dev.secret)).hello;
    const keys = sessionKeys(unb64(dev.secret), eph.secretKey, unb64(h.e), unb64(h.n), ns, unb64(h.e), eph.publicKey);
    return { frame: concat([T.WELCOME], n, nacl.secretbox(utf8(JSON.stringify(body)), n, key)), chan: new Channel(keys.s2c, keys.c2s) };
  }
  function openWelcome(frame, dev, hs) {
    frame = u8(frame); if (frame[0] !== T.WELCOME) return null;
    const key = deviceKeys(unb64(dev.secret)).hello;
    const m = nacl.secretbox.open(frame.subarray(25), frame.subarray(1, 25), key);
    if (!m) return null;
    let w; try { w = JSON.parse(fromUtf8(m)); } catch { return null; }
    if (w.echo !== b64(hs.nc)) return null; // not an answer to this hello
    const keys = sessionKeys(unb64(dev.secret), hs.eph.secretKey, unb64(w.e), hs.nc, unb64(w.n), hs.eph.publicKey, unb64(w.e));
    return { welcome: w, chan: new Channel(keys.c2s, keys.s2c) };
  }
  function sessionKeys(secret, mySecret, theirPub, nc, ns, ec, es) {
    const dh = nacl.scalarMult(mySecret, theirPub);
    const base = kdf('session', secret, dh, nc, ns, ec, es);
    return { c2s: kdf('c2s', base), s2c: kdf('s2c', base) };
  }

  // ---------- the sealed channel ----------
  function ctrNonce(ctr) { const n = new Uint8Array(24); let x = ctr; for (let i = 23; i >= 16; i--) { n[i] = x % 256; x = Math.floor(x / 256); } return n; }
  class Channel {
    constructor(sendKey, recvKey) { this.sk = sendKey; this.rk = recvKey; this.sc = 0; this.rc = 0; this.parts = new Map(); this.mid = 0; }
    seal(bytes) {
      const ctr = this.sc++; const nonce = ctrNonce(ctr);
      return concat([T.DATA], nonce.subarray(16), nacl.secretbox(u8(bytes), nonce, this.sk));
    }
    open(frame) {
      frame = u8(frame);
      if (frame[0] !== T.DATA || frame.length < 9 + 16) throw new Error('bad frame');
      const nonce = new Uint8Array(24); nonce.set(frame.subarray(1, 9), 16);
      let ctr = 0; for (let i = 1; i < 9; i++) ctr = ctr * 256 + frame[i];
      if (ctr !== this.rc) throw new Error('replayed or out-of-order frame');
      const m = nacl.secretbox.open(frame.subarray(9), nonce, this.rk);
      if (!m) throw new Error('frame failed authentication');
      this.rc++;
      return m;
    }
    // A message becomes one or more sealed frames.
    pack(obj) {
      const s = JSON.stringify(obj, replacer);
      if (s.length <= PART) return [this.seal(utf8(s))];
      const id = ++this.mid; const out = []; const n = Math.ceil(s.length / PART);
      for (let i = 0; i < n; i++) out.push(this.seal(utf8(JSON.stringify({ t: '~', m: id, i, n, d: s.slice(i * PART, (i + 1) * PART) }))));
      return out;
    }
    // Returns the message, or null while a split message is still arriving.
    unpack(frame) {
      const o = JSON.parse(fromUtf8(this.open(frame)), reviver);
      if (!o || o.t !== '~') return o;
      let p = this.parts.get(o.m); if (!p) { p = { n: o.n, got: 0, d: new Array(o.n) }; this.parts.set(o.m, p); }
      if (o.n > 20000 || p.d[o.i] !== undefined) throw new Error('bad part');
      p.d[o.i] = o.d; p.got++;
      if (p.got < p.n) return null;
      this.parts.delete(o.m);
      return JSON.parse(p.d.join(''), reviver);
    }
  }
  // Binary values (audio, files) ride inside the sealed JSON as {"$b": base64}.
  function replacer(k, v) {
    if (v && typeof v === 'object') {
      if (v.type === 'Buffer' && Array.isArray(v.data)) return { $b: b64(new Uint8Array(v.data)) };
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $b: b64(u8(v)) };
    }
    return v;
  }
  function reviver(k, v) { if (v && typeof v === 'object' && typeof v.$b === 'string' && Object.keys(v).length === 1) { const b = unb64(v.$b); return typeof Buffer !== 'undefined' ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : b; } return v; }
  // Buffer.toJSON runs before the replacer sees it; this catches Buffers anywhere in a payload.
  function prepBinary(x) {
    if (x == null || typeof x !== 'object') return x;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(x)) return { $b: x.toString('base64') };
    if (x instanceof ArrayBuffer || ArrayBuffer.isView(x)) return { $b: b64(u8(x)) };
    if (Array.isArray(x)) return x.map(prepBinary);
    if (Object.getPrototypeOf(x) !== Object.prototype) return x;
    const o = {}; for (const k of Object.keys(x)) o[k] = prepBinary(x[k]); return o;
  }
  const _pack = Channel.prototype.pack;
  Channel.prototype.pack = function (obj) { return _pack.call(this, prepBinary(obj)); };

  return { V, T, PART, nacl, utf8, fromUtf8, concat, b64, unb64, b64url, hex, rand, kdf, same, newCode, normCode, showCode, codeKeys, sealNote, openNote, deviceKeys, offerLink, parseOffer, pairRequest, openPairRequest, pairedFrame, openPaired, hello, openHello, welcome, openWelcome, Channel, prepBinary };
});
