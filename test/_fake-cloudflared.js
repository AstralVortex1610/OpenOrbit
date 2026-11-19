#!/usr/bin/env node
// Stand-in for cloudflared in tests: "cloudflared tunnel --url http://127.0.0.1:PORT" becomes a local
// WebSocket proxy that behaves like Cloudflare's edge after TLS termination: it sees every WebSocket
// message in the clear (as Cloudflare would) and records them all to FAKE_CF_LOG, so tests can check
// that only sealed bytes go through. It prints a trycloudflare-style URL and writes host -> port to FAKE_CF_MAP.
const http = require('http'); const fs = require('fs'); const crypto = require('crypto');
const WebSocket = require(require.resolve('ws', { paths: [process.cwd(), __dirname + '/..'] }));
const target = (process.argv[process.argv.indexOf('--url') + 1] || '').replace(/^http/, 'ws');
const host = 'fake-' + crypto.randomBytes(4).toString('hex') + '.trycloudflare.com';
const log = (dir, data) => { if (process.env.FAKE_CF_LOG) fs.appendFileSync(process.env.FAKE_CF_LOG, JSON.stringify({ dir, b64: Buffer.from(data).toString('base64') }) + '\n'); };
const srv = http.createServer((req, res) => {
  // plain HTTP (the health check) is forwarded too
  const r = http.request(target.replace(/^ws/, 'http') + req.url, { method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
  r.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(r);
});
const wss = new WebSocket.Server({ server: srv });
wss.on('connection', (down, req) => {
  log('upgrade', `${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n'));
  const up = new WebSocket(target + req.url, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  const q = [];
  up.on('open', () => { for (const m of q) up.send(m); q.length = 0; });
  down.on('message', (m) => { log('to-laptop', m); if (up.readyState === 1) up.send(m); else q.push(m); });
  up.on('message', (m) => { log('to-phone', m); if (down.readyState === 1) down.send(m); });
  const close = (ws, c, r) => { try { ws.close(c >= 1000 && c < 5000 && c !== 1005 && c !== 1006 ? c : 1000, r); } catch {} };
  up.on('close', (c, r) => close(down, c, r)); down.on('close', (c, r) => close(up, c, r));
  up.on('error', () => close(down, 1011)); down.on('error', () => close(up, 1011));
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  if (process.env.FAKE_CF_MAP) { let m = {}; try { m = JSON.parse(fs.readFileSync(process.env.FAKE_CF_MAP, 'utf8')); } catch {} m[host] = port; fs.writeFileSync(process.env.FAKE_CF_MAP, JSON.stringify(m)); }
  process.stderr.write(`INF Requesting new quick Tunnel on trycloudflare.com...\nINF |  https://${host}  |\n`);
  setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0 protocol=http2\n'), 200);
});
process.on('SIGTERM', () => process.exit(0));
