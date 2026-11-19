#!/usr/bin/env node
// Orbit Phone Link relay: a tiny, self-hosted forwarder for when the phone and the PC are on different
// networks and you don't want Cloudflare or ntfy in the path. Both sides connect OUT to it:
//   PC    -> wss://relay/host/<room>   (Authorization: Bearer <RELAY_TOKEN> when a token is set)
//   phone -> wss://relay/c/<room>
// It pairs them up and copies bytes. The bytes are Phone Link frames already sealed end-to-end inside
// Orbit (XSalsa20-Poly1305, keys from QR pairing), so the relay can't read or change them; it sees only
// the room id, connection times, sizes and IP addresses. It stores nothing.
//
//   npm install && RELAY_TOKEN=some-long-secret PORT=8787 node server.js
//   Put it behind a TLS proxy (Caddy, nginx) for wss://, or set TLS_CERT and TLS_KEY (PEM file paths).
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const OP = { OPEN: 1, DATA: 2, CLOSE: 3 };
const ROOM = /^[A-Za-z0-9_-]{16,64}$/;
function frame(op, id, payload) { const p = payload ? Buffer.from(payload) : Buffer.alloc(0); const b = Buffer.alloc(5 + p.length); b[0] = op; b.writeUInt32BE(id >>> 0, 1); p.copy(b, 5); return b; }

function createRelay({ port = Number(process.env.PORT) || 8787, host = process.env.HOST || '0.0.0.0', token = process.env.RELAY_TOKEN || '', maxRooms = 500, maxClients = 8, maxFrame = 1024 * 1024, log = console.log, tls = null, tap = null } = {}) {
  const rooms = new Map(); // room -> { host: ws, clients: Map<id, ws>, next }
  const perIp = new Map();
  const limited = (ip) => { const now = Date.now(); const a = (perIp.get(ip) || []).filter(t => now - t < 60000); a.push(now); perIp.set(ip, a); if (perIp.size > 10000) perIp.clear(); return a.length > 60; };
  const tokenOk = (req) => {
    if (!token) return true;
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = crypto.createHash('sha256').update(got).digest(); const b = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const handler = (req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain' }); res.end(req.url === '/health' ? 'ok' : 'Orbit relay'); };
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrame + 16 });
  const reject = (sock, code, text) => { try { sock.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); } catch {} sock.destroy(); };

  server.on('upgrade', (req, sock, head) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (limited(ip)) return reject(sock, 429, 'Too Many Requests');
    const m = String(req.url || '').match(/^\/(host|c)\/([^/?#]+)/);
    if (!m || !ROOM.test(decodeURIComponent(m[2]))) return reject(sock, 404, 'Not Found');
    const kind = m[1]; const room = decodeURIComponent(m[2]);
    if (kind === 'host' && !tokenOk(req)) return reject(sock, 401, 'Unauthorized');
    wss.handleUpgrade(req, sock, head, (ws) => (kind === 'host' ? onHost(ws, room) : onClient(ws, room, ip)));
  });

  function onHost(ws, room) {
    let r = rooms.get(room);
    if (!r && rooms.size >= maxRooms) { ws.close(1013, 'relay full'); return; }
    if (r && r.host) { try { r.host.close(4000, 'replaced'); } catch {} for (const c of r.clients.values()) c.close(4404, 'laptop reconnecting'); r.clients.clear(); }
    if (!r) { r = { host: null, clients: new Map(), next: 1 }; rooms.set(room, r); }
    r.host = ws; ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      const b = Buffer.from(data); if (b.length < 5) return;
      const op = b[0]; const id = b.readUInt32BE(1); const c = r.clients.get(id); if (!c) return;
      if (op === OP.DATA) { if (tap) tap('to-phone', b.subarray(5)); if (c.readyState === 1) c.send(b.subarray(5), { binary: true }); }
      else if (op === OP.CLOSE) { // the laptop's close code reaches the phone (e.g. 4401 = this phone was revoked)
        let code = b.length >= 7 ? b.readUInt16BE(5) : 1000; if (code < 1000 || code >= 5000 || code === 1005 || code === 1006) code = 1000;
        r.clients.delete(id); c.close(code, b.length > 7 ? b.subarray(7).toString('utf8').slice(0, 60) : 'closed by laptop');
      }
    });
    ws.on('close', () => {
      if (r.host !== ws) return;
      r.host = null;
      for (const c of r.clients.values()) c.close(4404, 'laptop offline');
      r.clients.clear(); rooms.delete(room);
    });
    ws.on('error', () => {});
  }

  function onClient(ws, room, ip) {
    const r = rooms.get(room);
    if (!r || !r.host) { ws.close(4404, 'laptop offline'); return; }
    if (r.clients.size >= maxClients) { ws.close(1013, 'too many phones'); return; }
    const id = r.next++ >>> 0;
    r.clients.set(id, ws); ws.isAlive = true;
    r.host.send(frame(OP.OPEN, id, JSON.stringify({ ip })));
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => { if (tap) tap('to-laptop', Buffer.from(data)); if (r.host && r.host.readyState === 1) r.host.send(frame(OP.DATA, id, data)); });
    ws.on('close', () => { if (r.clients.get(id) === ws) { r.clients.delete(id); if (r.host && r.host.readyState === 1) r.host.send(frame(OP.CLOSE, id)); } });
    ws.on('error', () => {});
  }

  const beat = setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 30000);
  return new Promise((resolve) => server.listen(port, host, () => {
    log(`Orbit relay on ${tls ? 'wss' : 'ws'}://${host}:${server.address().port}${token ? ' (host token required)' : ' (no host token: set RELAY_TOKEN)'}`);
    resolve({ server, port: server.address().port, rooms, close: () => new Promise(res => { clearInterval(beat); for (const ws of wss.clients) ws.terminate(); server.close(() => res()); }) });
  }));
}

module.exports = { createRelay, frame, OP };
if (require.main === module) {
  const tls = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
  createRelay({ tls });
}
