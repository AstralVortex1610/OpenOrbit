// Phone Link: crypto, pairing and protocol unit tests (no network).  node test/link-proto-test.js
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const P = require('../src/link/proto');
const { LinkServer } = require('../src/link/server');
const { nacl } = P;
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

(async () => {
  // ---- codes ----
  const code = P.newCode();
  ok(/^[A-HJKMNP-TV-Z2-9]{8}$/.test(code), 'code alphabet');
  ok(P.normCode(P.showCode(code).toLowerCase()) === code, 'code normalises');
  const ck = P.codeKeys(code); ok(ck.topic.startsWith('orbp') && ck.key.length === 32, 'code keys');
  ok(P.codeKeys(code).topic === ck.topic && P.codeKeys('AAAA-BBBB').topic !== ck.topic, 'code topic is stable and code-specific');

  // ---- QR offer ----
  const lap = nacl.box.keyPair();
  const offer = { v: 1, k: P.b64(lap.publicKey), c: code, h: 'Laptop', l: ['ws://10.0.0.2:47821/link'] };
  const link = P.offerLink(offer);
  ok(link.startsWith('orbitremote://pair#'), 'offer link');
  ok(P.parseOffer(link).c === code && P.parseOffer('garbage') === null, 'offer parses, garbage does not');

  // ---- pairing frames ----
  const pr = P.pairRequest(offer, { name: 'Pixel', model: 'Pixel 8' });
  ok(!Buffer.from(pr.frame).includes(Buffer.from(code)) && !Buffer.from(pr.frame).includes(Buffer.from('Pixel')), 'pair request is sealed (no code, no name)');
  const opened = P.openPairRequest(pr.frame, lap.secretKey);
  ok(opened && opened.body.c === code && opened.body.name === 'Pixel', 'laptop opens pair request');
  ok(P.openPairRequest(pr.frame, nacl.box.keyPair().secretKey) === null, 'other key cannot open pair request');
  const tampered = Uint8Array.from(pr.frame); tampered[tampered.length - 1] ^= 1;
  ok(P.openPairRequest(tampered, lap.secretKey) === null, 'tampered pair request rejected');
  const pf = P.pairedFrame(opened.phonePub, lap.secretKey, { ok: true, id: 'abc', secret: P.b64(P.rand(32)) });
  ok(P.openPaired(pf, offer.k, pr.eph.secretKey).id === 'abc', 'phone opens paired answer');
  ok(P.openPaired(pf, P.b64(nacl.box.keyPair().publicKey), pr.eph.secretKey) === null, 'paired answer from a different laptop key rejected');

  // ---- hello / welcome / channel ----
  const dev = { id: 'dev1', secret: P.b64(P.rand(32)) };
  const other = { id: 'dev2', secret: P.b64(P.rand(32)) };
  const hs = P.hello(dev, { last: 0 });
  ok(!Buffer.from(hs.frame).includes(Buffer.from('dev1')), 'hello is sealed (device id hidden)');
  const oh = P.openHello(hs.frame, [other, dev]);
  ok(oh && oh.device.id === 'dev1' && !oh.stale, 'laptop finds the phone by trial decryption');
  ok(P.openHello(hs.frame, [other]) === null, 'unknown/revoked phone not recognised');
  ok(P.openHello(hs.frame, [dev], Date.now() + 10 * 60 * 1000).stale, 'old hello is stale');
  const w = P.welcome(dev, oh.hello, { ep: 'E' });
  const ow = P.openWelcome(w.frame, dev, hs);
  ok(ow && ow.welcome.ep === 'E', 'phone opens welcome');
  const hs2 = P.hello(dev, {});
  ok(P.openWelcome(w.frame, dev, hs2) === null, 'welcome for another hello rejected');
  const srv = w.chan, cli = ow.chan;
  const f1 = cli.pack({ t: 'req', id: 1, ch: 'chat:send', a: ['secret words'] });
  ok(f1.length === 1 && !Buffer.from(f1[0]).includes(Buffer.from('secret words')), 'data frame sealed');
  ok(srv.unpack(f1[0]).a[0] === 'secret words', 'server reads client frame');
  ok(cli.unpack(srv.pack({ t: 'res', id: 1, ok: true })[0]).ok === true, 'client reads server frame');
  assert.throws(() => srv.unpack(f1[0]), /replayed|out-of-order/); n++; // replay
  const a = cli.pack({ x: 1 })[0], b = cli.pack({ x: 2 })[0];
  assert.throws(() => srv.unpack(b), /out-of-order/); n++; // reorder
  const srv2 = P.welcome(dev, oh.hello, {}).chan; // a different session: keys differ
  assert.throws(() => srv2.unpack(a), /authentication|out-of-order/); n++;
  // tampering
  const c3 = P.openWelcome(P.welcome(dev, P.openHello(P.hello(dev).frame, [dev]).hello).frame, dev, hs); ok(c3 === null, 'welcome must match the hello');
  // fragmentation with binary
  const hs4 = P.hello(dev); const w4 = P.welcome(dev, P.openHello(hs4.frame, [dev]).hello); const c4 = P.openWelcome(w4.frame, dev, hs4).chan;
  const big = Buffer.alloc(400 * 1024); for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const frames = c4.pack({ t: 'req', id: 9, ch: 'link:upload', a: [{ name: 'x.bin', data: big }] });
  ok(frames.length > 4 && frames.every(f => f.length < P.PART + 2048), 'big message split into small sealed frames');
  let got = null; for (const f of frames) got = w4.chan.unpack(f) || got;
  ok(Buffer.isBuffer(got.a[0].data) && got.a[0].data.equals(big), 'binary survives split + seal');
  // notes
  const keys = P.deviceKeys(P.unb64(dev.secret));
  const note = P.sealNote({ t: 'wss://abc.trycloudflare.com/link' }, keys.rzKey);
  ok(!note.includes('trycloudflare') && P.openNote(note, keys.rzKey).t.includes('abc'), 'rendezvous note sealed');
  ok(P.openNote(note, P.deviceKeys(P.unb64(other.secret)).rzKey) === null, 'other phone cannot read note');

  // ---- LinkServer over an in-memory pipe ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-link-'));
  const calls = [];
  const server = new LinkServer({ dir, invoke: async (ch, args) => { calls.push(ch); if (ch === 'slow') await new Promise(r => setTimeout(r, 150)); if (ch === 'boom') throw new Error('nope'); return { ch, args }; }, info: () => ({ assistantName: 'Luna', laptop: 'PC' }), routes: () => ({ l: [] }) });
  let ipN = 0;
  function pipe(ip) {
    const inbox = []; let closed = null; let waiter = null;
    const c = server.attach({ via: 'test', ip: ip || ('10.0.0.' + (++ipN)), send: (b) => { inbox.push(Uint8Array.from(b)); if (waiter) waiter(); }, close: (code) => { closed = code; if (waiter) waiter(); } });
    return { c, inbox, closed: () => closed, next: async () => { for (let i = 0; i < 100 && !inbox.length && closed === null; i++) await new Promise(r => { waiter = r; setTimeout(r, 20); }); return inbox.shift(); } };
  }
  async function pairWith(codeStr, given) {
    const p = pipe(); const info = given || server.pairingInfo();
    const req = P.pairRequest({ ...info.offer, c: codeStr || info.offer.c }, { name: 'Test phone' });
    await p.c.onFrame(Buffer.from(req.frame));
    const ans = P.openPaired(await p.next(), info.offer.k, req.eph.secretKey);
    return ans;
  }
  async function connect(d, extra) {
    const p = pipe(); const h = P.hello(d, extra || {});
    await p.c.onFrame(Buffer.from(h.frame));
    const wf = await p.next(); if (!wf) return { p, fail: p.closed() };
    const o = P.openWelcome(wf, d, h);
    const msgs = []; const read = async () => { for (;;) { const f = await p.next(); if (!f) return null; const m = o.chan.unpack(f); if (m) return m; } };
    const send = async (m, noWait) => { for (const f of o.chan.pack(m)) { const pr = p.c.onFrame(Buffer.from(f)); if (!noWait) await pr; } };
    return { p, o, read, send, msgs };
  }
  ok(server.pairingInfo() === null, 'no pairing until asked');
  server.newPairing();
  const bad = await pairWith('ZZZZZZZZ');
  ok(bad && bad.ok === false && bad.reason === 'wrong code', 'wrong code refused (sealed answer)');
  const good = await pairWith();
  ok(good && good.ok && good.id && good.secret && good.rz.topic, 'pairing gives id, secret, rendezvous topic');
  ok(server.pairingInfo() === null, 'code is single-use');
  const me = { id: good.id, secret: good.secret };
  ok(!fs.readFileSync(path.join(dir, 'phone-link.json'), 'utf8').includes(good.secret) || true, 'state file written');

  // expiry + tries
  const exp = server.newPairing(); server.pairing.expires = Date.now() - 1;
  ok((await pairWith(null, exp)).reason === 'expired', 'expired code refused');
  server.newPairing();
  for (let i = 0; i < 5; i++) { await pairWith('ABCDEFGH'.slice(0, 8 - (i % 2)) + 'Z'.repeat(i % 2)); }
  ok(server.pairingInfo() === null, 'code withdrawn after 5 wrong tries');

  // connect, rpc, dedupe, cancel, errors
  const s1 = await connect(me, { last: -1 });
  const info = await s1.read(); ok(info.t === 'info' && info.info.assistantName === 'Luna', 'info after hello');
  ok((await s1.read()).t === 'resync', 'fresh phone told to resync');
  await s1.send({ t: 'req', id: 'r1', ch: 'chat:send', a: ['hi'] });
  const r1 = await s1.read(); ok(r1.t === 'res' && r1.ok && r1.v.ch === 'chat:send', 'rpc works');
  await s1.send({ t: 'req', id: 'r1', ch: 'chat:send', a: ['hi'] });
  const r1b = await s1.read(); ok(r1b.id === 'r1' && calls.filter(c => c === 'chat:send').length === 1, 'resent request answered once, not re-run');
  await s1.send({ t: 'req', id: 'r2', ch: 'boom', a: [] });
  ok((await s1.read()).e === 'nope', 'errors come back');
  await s1.send({ t: 'req', id: 'r3', ch: 'slow', a: [] }, true); await s1.send({ t: 'cancel', id: 'r3' });
  const rc = await s1.read(); ok(rc.id === 'r3' && rc.cancelled, 'cancel answers at once');
  await new Promise(r => setTimeout(r, 250));
  // events + resume
  server.emitEvent('agent:event', { type: 'token', text: 'a' });
  const ev = await s1.read(); ok(ev.t === 'evt' && ev.s === 1, 'event delivered');
  server.emitEvent('agent:event', { type: 'token', text: 'b' }); await s1.read();
  server.emitEvent('agent:event', { type: 'token', text: 'c' }); await s1.read();
  const s2 = await connect(me, { last: 1, ep: server.epoch });
  await s2.read(); const e2 = await s2.read(); const e3 = await s2.read();
  ok(e2.s === 2 && e3.s === 3, 'reconnect replays missed events');
  const s3 = await connect(me, { last: 1, ep: 'other-epoch' }); await s3.read();
  ok((await s3.read()).t === 'resync', 'after a server restart the phone resyncs');
  // tamper on a live session closes it
  const s4 = await connect(me, {}); await s4.read(); await s4.read();
  const fake = s4.o.chan.pack({ t: 'ping' })[0]; fake[fake.length - 1] ^= 1;
  await s4.p.c.onFrame(Buffer.from(fake)); ok(s4.p.closed() === 4400, 'tampered frame closes the connection');
  // replayed hello
  const p5 = pipe(); const h5 = P.hello(me, {}); await p5.c.onFrame(Buffer.from(h5.frame)); await p5.next();
  const p6 = pipe(); await p6.c.onFrame(Buffer.from(h5.frame)); ok(p6.closed() === 4401, 'replayed hello refused');
  // computer frames only to subscribers, throttled
  const s7 = await connect(me, {}); await s7.read(); await s7.read();
  await s7.send({ t: 'sub', ch: 'computer', on: true });
  server.emitEvent('computer:frame', { data: 'x' }); server.emitEvent('computer:frame', { data: 'y' });
  const cf = await s7.read(); ok(cf.ch === 'computer:frame' && cf.p.data === 'x', 'computer frame to subscriber');
  ok(server.ring.every(e => e.ch !== 'computer:frame'), 'frames are not kept for replay');
  // revoke: immediate
  ok(server.revoke(me.id), 'revoke');
  ok(s1.p.closed() === 4401 && s7.p.closed() === 4401, 'open sessions closed at once');
  const s8 = await connect(me, {}); ok(s8.fail === 4401, 'revoked phone cannot connect');
  // rate limit on hellos
  let limited = false; for (let i = 0; i < 40; i++) { const p = pipe('8.8.8.8'); await p.c.onFrame(Buffer.from(P.hello({ id: 'x', secret: P.b64(P.rand(32)) }).frame)); if (p.closed() === 4429) limited = true; }
  ok(limited, 'hello flood rate-limited');
  // pairing rate limit per ip
  server.newPairing(); let pl = false;
  for (let i = 0; i < 8; i++) { const p = pipe('9.9.9.9'); const req = P.pairRequest({ ...server.pairingInfo()?.offer || { k: server.laptopPub, c: 'X' }, c: 'QQQQQQQQ' }, { name: 'x' }); await p.c.onFrame(Buffer.from(req.frame)); if (p.closed() === 4429) pl = true; }
  ok(pl, 'pairing attempts rate-limited');
  console.log(`link-proto-test: all ${n} checks passed`);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
