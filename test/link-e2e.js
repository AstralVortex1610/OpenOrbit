// Phone Link end to end: the real Orbit main process (headless, mock model) with Phone Link on, and a scripted
// phone (the same LinkClient the Android app runs) that pairs, chats, cancels, sends and downloads files,
// survives a link restart through the rendezvous note, sees "updating" and "offline", and gets revoked.
// Cloudflare and ntfy are replaced by local recording fakes (test/_fake-cloudflared.js, fakeNtfy), and a run
// through the self-hosted relay (relay/server.js, recording too). Every byte those three forwarded is then
// searched for plaintext (chat text, file content, model name, assistant name, user name, pairing code...).
//   xvfb-run -a npx electron --no-sandbox test/link-e2e.js      (SHOTS=dir to save the desktop screenshot)
const { app, BrowserWindow } = require('electron');
const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const WebSocket = require('ws');
const { LinkClient } = require('../src/link/client');
const P = require('../src/link/proto');
const { fakeNtfy, findLeaks, readCfLog, FAKE_CF } = require('./_link-fakes');
const { createRelay } = require('../relay/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-link-e2e-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();
process.env.ORBIT_TEST_HOOKS = '1';
process.env.ORBIT_CLOUDFLARED = FAKE_CF;
process.env.FAKE_CF_LOG = path.join(tmp, 'cf-bytes.jsonl');
process.env.FAKE_CF_MAP = path.join(tmp, 'cf-map.json');

const SECRETS = { chat: 'PURPLE-ELEPHANT-7731', reply: 'Tangerine-Lighthouse-4410', file: 'FILE-CONTENT-SECRET-5512', model: 'mock-model-xyzzy', name: 'Zephyrine', user: 'Meherunnisa', fileName: 'quarterly-plan-secret.txt' };
let modelCalls = 0;
const model = http.createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
    modelCalls++;
    let j = {}; try { j = JSON.parse(body); } catch {}
    const last = JSON.stringify((j.messages || []).slice(-1));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (t) => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
    if (/SLOW-TASK/.test(last)) { // a long answer, so the phone can stop it halfway
      let i = 0; const t = setInterval(() => { if (i++ > 60) { clearInterval(t); res.write('data: [DONE]\n\n'); res.end(); return; } try { chunk('word' + i + ' '); } catch {} }, 150);
      req.on('close', () => clearInterval(t)); res.on('close', () => clearInterval(t)); return;
    }
    chunk(`Sure. ${SECRETS.reply}. `); chunk('Done.');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 20 } }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0; let passed = 0;
const check = (cond, msg) => { if (cond) { passed++; console.log('ok:', msg); } else { failed++; console.log('FAIL:', msg); } };
async function until(fn, ms = 15000, step = 100) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(step); } return null; }
const mem = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => (v == null ? m.delete(k) : m.set(k, v)) }; };
const cfMap = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_CF_MAP, 'utf8')); } catch { return {}; } };
const resolveUrl = (u) => { const m = u.match(/^wss:\/\/([^/]+)(\/.*)$/); if (m && cfMap()[m[1]]) return `ws://127.0.0.1:${cfMap()[m[1]]}${m[2]}`; return u; };
// noLan: this phone is on another network, so the laptop's LAN addresses don't answer it.
function phone(name, noLan) { return new LinkClient({ WebSocket, fetch: (u, o) => fetch(u, o), storage: mem(), device: { name, model: 'Test ' + name }, resolveUrl: (u) => (noLan && /^ws:\/\/(?!127\.0\.0\.1:\d+\/c\/)/.test(u) ? 'ws://127.0.0.1:9/link' : resolveUrl(u)), lanTimeout: 1500, remoteTimeout: 4000, log: (m) => process.env.DEBUG && console.log(`[${name}]`, m) }); }

model.listen(0, async () => {
  const ntfy = await fakeNtfy();
  const relayBytes = [];
  const relay = await createRelay({ port: 0, host: '127.0.0.1', token: 'relay-token-123', log: () => {}, tap: (dir, b) => relayBytes.push(Buffer.from(b)) });
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
    apiKeyEnc: Buffer.from('sk-test-key-never-on-phone').toString('base64'), baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: SECRETS.model,
    userName: SECRETS.user, assistantName: SECRETS.name, closeToTray: false, autoCall: false, autoUpdate: false, talkFirst: false,
    phoneLinkEnabled: true, phoneLinkPort: 47900, phoneLinkRemote: 'cloudflare', phoneLinkRendezvous: ntfy.url,
  }));
  require('../src/main.js');
  app.whenReady().then(async () => {
    try {
      await wait(2500);
      const win = BrowserWindow.getAllWindows()[0];
      const js = (s) => win.webContents.executeJavaScript(s);
      const PL = global.__orbit.phoneLink;
      let st = await until(async () => { const s = await js('orbit.phoneLink.status()'); return s.on && s.tunnel && s.tunnel.state === 'up' ? s : null; });
      check(!!st, 'Phone Link on: LAN server + (fake) Cloudflare tunnel up');
      check(st && st.lan.length >= 0 && st.port > 0, `link server listening on port ${st && st.port}`);

      // ---- desktop UI: pair a phone from Settings → Phone Link (QR + code) ----
      win.setSize(1280, 860); win.show();
      await js(`document.querySelector('[data-view=settings]').click()`); await wait(600);
      await js(`document.querySelector('#plPairBtn').click()`); await wait(1200);
      const qrShown = await js(`!document.querySelector('#plQr').hidden && document.querySelector('#plQrImg').src.startsWith('data:image/png')`);
      check(qrShown, 'Settings shows a QR code and a short code');
      const codeText = await js(`document.querySelector('#plCode').textContent`);
      check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codeText), `short code shown (${codeText})`);
      await js(`document.querySelector('#plCard').scrollIntoView({block:'start'})`); await wait(400);
      if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.SHOTS, 'desktop-phone-link-qr.png'), (await win.webContents.capturePage()).toPNG()); }
      st = await js('orbit.phoneLink.status()');
      const offer = P.parseOffer(st.pairing.link);
      check(offer && offer.l && offer.t && offer.z, 'QR offer carries LAN addresses, tunnel and rendezvous');

      // ---- phone A: pairs and works on the same network ----
      const A = phone('Phone A');
      const lanOffer = { ...offer, l: [`ws://127.0.0.1:${st.port}/link`] }; // the test host's own LAN
      // short code path: the offer is fetched (sealed) from the rendezvous topic derived from the code
      const viaCode = await A.lookupCode(codeText, ntfy.url);
      check(viaCode.k === offer.k && viaCode.c === P.normCode(codeText), 'short code finds the sealed pairing offer');
      await A.pair(lanOffer);
      check(A.paired, 'phone A paired');
      const devs = (await js('orbit.phoneLink.status()')).devices;
      check(devs.length === 1 && devs[0].name === 'Phone A', 'desktop lists the paired phone');
      const events = []; A.on('agent:event', (e) => events.push(e));
      A.start();
      check(await until(() => A.state === 'online'), 'phone A online');
      check(A.via === 'lan', `phone A connected via ${A.via}`);
      check(await until(() => A.info && A.info.assistantName === SECRETS.name, 3000), 'phone gets the custom assistant name');
      const s = await A.invoke('settings:get', []);
      check(s.model === SECRETS.model && !s.apiKey && !s.apiKeyEnc && s.hasKey === true, 'settings reach the phone without the API key');
      const ch = await A.invoke('models:choices', []).catch(e => ({ err: e.message }));
      check(ch && !ch.err, 'model tiers list available on phone');

      // chat with streaming
      await A.invoke('chat:send', [`Please repeat ${SECRETS.chat}`, []]);
      const end = await until(() => events.find(e => e.type === 'assistant_end'));
      check(end && end.text.includes(SECRETS.reply), 'chat reply streamed back');
      check(events.some(e => e.type === 'busy') && events.some(e => e.type === 'user_message'), 'progress events (busy, user message) arrive');
      const thread = await A.invoke('thread:get', []);
      check(thread.some(m => JSON.stringify(m.content).includes(SECRETS.chat)), 'conversation history from the laptop');

      // edit a message (0.12.4 feature) through the phone
      const um = thread.filter(m => m.role === 'user').pop();
      const ed = await A.invoke('chat:edit', ['main', um.id, `Edited ${SECRETS.chat}`]).catch(e => ({ err: e.message }));
      check(ed && !ed.err, 'message edit works from the phone');
      await until(() => events.filter(e => e.type === 'assistant_end').length >= 2, 8000);

      // stop / cancel
      events.length = 0;
      await A.invoke('chat:send', ['SLOW-TASK please', []]);
      await until(() => events.some(e => e.type === 'delta' || e.type === 'text'), 6000);
      await wait(500);
      await A.invoke('chat:stop', []);
      const stopped = await until(() => events.find(e => e.type === 'busy' && e.busy === false), 8000);
      check(!!stopped, 'stop from the phone ends the running task');
      // cancel a request that is still waiting
      const slowReq = A.invoke('voice:transcribe', [new Uint8Array([1, 2, 3]), 'audio/webm']);
      const cancelledId = A.cancelLast('voice:transcribe');
      const cr = await slowReq.then(() => 'resolved', e => (e.cancelled ? 'cancelled' : e.message));
      check(cancelledId && cr === 'cancelled', 'a pending request can be cancelled');

      // files: phone -> laptop, laptop -> phone
      const up = await A.invoke('link:upload', [{ name: SECRETS.fileName, data: Buffer.from(`hello ${SECRETS.file} `.repeat(30000)) }]);
      check(up && fs.existsSync(up.path) && fs.readFileSync(up.path, 'utf8').includes(SECRETS.file), `file sent to the laptop (${up && up.size} bytes, sealed in parts)`);
      const down = await A.invoke('link:file', [up.path]);
      check(down && Buffer.from(down.data).toString('utf8') === fs.readFileSync(up.path, 'utf8'), 'file downloaded back to the phone');
      const bad = await A.invoke('link:file', [path.join(tmp, 'settings.json')]).then(() => 'allowed', e => e.message);
      check(bad !== 'allowed', 'settings.json is not downloadable');
      const rev = await A.invoke('passwords:reveal', ['x']).then(() => 'allowed', e => e.message);
      check(/laptop/.test(rev), 'revealing passwords is refused from the phone');
      const pl = await A.invoke('phoneLink:revoke', ['x']).then(() => 'allowed', e => e.message);
      check(pl !== 'allowed', 'a phone cannot manage Phone Link');
      const sv = await A.invoke('settings:save', [{ phoneLinkEnabled: false, userName: SECRETS.user }]);
      check(global.__orbit.store.getSettings().phoneLinkEnabled === true && sv, 'phone settings save cannot turn Phone Link off');

      // ---- phone B: another network (tunnel only), then the link restarts with a new tunnel address ----
      await js('orbit.phoneLink.pair()'); st = await js('orbit.phoneLink.status()');
      const offB = P.parseOffer(st.pairing.link);
      const B = phone('Phone B', true);
      await B.pair({ ...offB, l: [] }); // no LAN: as if on mobile data
      B.pairing.routes.l = [];
      const bEvents = []; B.on('agent:event', (e) => bEvents.push(e)); let resyncs = 0; B.on('link:resync', () => resyncs++);
      B.start();
      check(await until(() => B.state === 'online'), 'phone B online');
      check(B.via === 'tunnel', `phone B connected via ${B.via}`);
      const oldTunnel = B.pairing.routes.t;
      const r0 = resyncs;
      await js(`orbit.saveSettings({ phoneLinkEnabled: false })`);
      check(await until(() => ['offline', 'connecting'].includes(B.state), 8000), `phone B sees the laptop go away (${B.state})`);
      check(await until(() => B.state === 'offline', 12000), 'phone B shows "Laptop offline"');
      // a request made while the laptop is away waits in the queue...
      const queued = B.invoke('home:summary', []);
      check(B.queued().length >= 1, 'request queued while offline');
      await js(`orbit.saveSettings({ phoneLinkEnabled: true })`);
      check(await until(async () => { const x = await js('orbit.phoneLink.status()'); return x.tunnel && x.tunnel.state === 'up' && x.tunnel.url; }), 'link restarted with a new tunnel');
      B.kick();
      check(await until(() => B.state === 'online', 25000), 'phone B reconnected after the restart');
      check(B.pairing.routes.t && B.pairing.routes.t !== oldTunnel, 'found the new tunnel address via the sealed rendezvous note');
      check(B.via === 'tunnel', 'still via tunnel (no LAN)');
      const qv = await Promise.race([queued, wait(8000).then(() => 'timeout')]);
      check(qv && qv !== 'timeout' && typeof qv.unread === 'number', '...and is answered after the reconnect');
      check(resyncs > r0, 'phone told to resync after the laptop restarted the link');
      // a chat and a file over the tunnel (these bytes are what the sniff check reads)
      bEvents.length = 0;
      await B.invoke('chat:send', [`Tunnel check ${SECRETS.chat}`, []]);
      check(await until(() => bEvents.find(e => e.type === 'assistant_end' && e.text.includes(SECRETS.reply))), 'chat streams through the tunnel');
      const upB = await B.invoke('link:upload', [{ name: SECRETS.fileName, data: Buffer.from(`${SECRETS.file} `.repeat(5000)) }]);
      check(upB && upB.size === (SECRETS.file.length + 1) * 5000, 'file through the tunnel');
      const t2 = await B.invoke('thread:get', []); check(Array.isArray(t2) && t2.length > 2, 'history through the tunnel');
      await B.invoke('settings:get', []);
      check(ntfy.seen.length >= 2, `rendezvous notes posted (${ntfy.seen.length})`);

      // laptop updating: phones see it
      await PL.announce('updating');
      check(await until(() => B.state === 'updating' || A.state === 'updating', 5000), 'phones show "Laptop is updating"');
      PL.appState = 'online'; await PL.publish('test', 'online');
      // Phone Link plays nicely with the updater: a phone in use blocks the idle auto-install
      await A.invoke('home:summary', []).catch(() => {});
      check(PL.inUse(), 'phone activity counts as "in use" for the auto-updater');

      // ---- phone C via the self-hosted relay (no Cloudflare, no ntfy) ----
      await js(`orbit.saveSettings({ phoneLinkRemote: 'relay', phoneLinkRelayUrl: 'ws://127.0.0.1:${relay.port}', phoneLinkRelayToken: 'relay-token-123', phoneLinkNoThirdParty: true })`);
      check(await until(async () => { const x = await js('orbit.phoneLink.status()'); return x.relay && x.relay.state === 'up'; }), 'desktop connected out to the relay');
      const st3 = await js('orbit.phoneLink.status()');
      check(!st3.tunnel && !st3.rendezvous, 'third-party off: no tunnel, no ntfy');
      await js('orbit.phoneLink.pair()'); const offC = P.parseOffer((await js('orbit.phoneLink.status()')).pairing.link);
      check(offC.r && !offC.t && !offC.z, 'QR offer now names only LAN + relay');
      const C = phone('Phone C', true); await C.pair({ ...offC, l: [] }); C.pairing.routes.l = [];
      const cEvents = []; C.on('agent:event', (e) => cEvents.push(e)); C.start();
      check(await until(() => C.state === 'online'), 'phone C online');
      check(C.via === 'relay', `phone C connected via ${C.via}`);
      await C.invoke('chat:send', [`Relay check ${SECRETS.chat}`, []]);
      check(await until(() => cEvents.find(e => e.type === 'assistant_end' && e.text.includes(SECRETS.reply))), 'chat works through the relay');
      const upC = await C.invoke('link:upload', [{ name: SECRETS.fileName, data: Buffer.from(SECRETS.file) }]);
      check(upC && upC.size === SECRETS.file.length, 'file through the relay');
      await C.invoke('settings:get', []);
      const badTok = await createRelay({ port: 0, host: '127.0.0.1', token: 'other', log: () => {} });
      await badTok.close();

      // ---- revoke: immediate ----
      await js(`orbit.phoneLink.revoke(${JSON.stringify(C.pairing.id)})`);
      check(await until(() => C.state === 'revoked', 5000), 'revoked phone is cut off at once');
      check(!C.paired, 'revoked phone forgets the pairing');

      // ---- no plaintext through Cloudflare (fake), ntfy (fake) or the relay ----
      const cf = readCfLog(process.env.FAKE_CF_LOG);
      const secrets = [SECRETS.chat, SECRETS.reply, SECRETS.file, SECRETS.model, SECRETS.name, SECRETS.user, SECRETS.fileName, 'Phone B', 'Phone C', 'sk-test-key', P.normCode(codeText), 'trycloudflare', '127.0.0.1:' + relay.port, os.hostname()];
      const cfL = findLeaks(cf.filter(x => x.dir !== 'upgrade').map(x => x.data), secrets);
      check(cf.length > 20 && cfL.found.length === 0, `tunnel saw ${cfL.bytes} bytes in ${cf.length} messages, no plaintext${cfL.found.length ? ' LEAKED: ' + cfL.found.join(', ') : ''}`);
      const up0 = cf.filter(x => x.dir === 'upgrade').map(x => x.data.toString()).join('\n');
      check(!findLeaks([Buffer.from(up0)], secrets.filter(x => x !== 'trycloudflare')).found.length, 'tunnel upgrade requests carry nothing secret');
      const nzL = findLeaks(ntfy.seen.map(x => Buffer.from(x.topic + ' ' + x.body)), secrets);
      check(nzL.found.length === 0, `rendezvous saw ${ntfy.seen.length} notes, no plaintext (not even the tunnel address)${nzL.found.length ? ' LEAKED: ' + nzL.found.join(', ') : ''}`);
      const rlL = findLeaks(relayBytes, secrets);
      check(relayBytes.length > 10 && rlL.found.length === 0, `relay saw ${rlL.bytes} bytes, no plaintext${rlL.found.length ? ' LEAKED: ' + rlL.found.join(', ') : ''}`);
      // control: the same search does find the secrets in plaintext (so the check itself works)
      check(findLeaks([Buffer.from(`x ${SECRETS.chat} y`)], [SECRETS.chat]).found.length === 1 && findLeaks([Buffer.from(Buffer.from(`ab ${SECRETS.file} cd`).toString('base64'))], [SECRETS.file]).found.length === 1, 'leak detector catches plaintext and base64');
      fs.writeFileSync(path.join(tmp, 'sniff-summary.json'), JSON.stringify({ tunnelMessages: cf.length, tunnelBytes: cfL.bytes, ntfyNotes: ntfy.seen.length, relayBytes: rlL.bytes }, null, 1));
      console.log('sniff summary:', fs.readFileSync(path.join(tmp, 'sniff-summary.json'), 'utf8').replace(/\s+/g, ' '));
      A.stop(); B.stop(); C.stop();
    } catch (e) { failed++; console.log('FAIL: exception', e && e.stack); }
    console.log(failed ? `link-e2e: ${failed} FAILED, ${passed} passed` : `link-e2e: all ${passed} checks passed`);
    try { await global.__orbit.phoneLink.stop(); } catch {}
    try { relay.close(); } catch {}
    app.exit(failed ? 1 : 0);
  });
});
