// Test doubles for Phone Link: a recording ntfy server, a recording relay, and helpers to look for plaintext leaks.
const http = require('http'); const fs = require('fs'); const path = require('path');

// Minimal ntfy: POST /<topic> stores the body; GET /<topic>/json?poll=1 returns stored messages as ntfy JSON lines.
function fakeNtfy() {
  const topics = new Map(); const seen = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const parts = u.pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts.length === 1) {
      let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
        seen.push({ topic: parts[0], body: b });
        if (!topics.has(parts[0])) topics.set(parts[0], []);
        topics.get(parts[0]).push({ id: String(seen.length), time: Math.floor(Date.now() / 1000), event: 'message', topic: parts[0], message: b });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end('{}');
      });
      return;
    }
    if (req.method === 'GET' && parts[1] === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Access-Control-Allow-Origin': '*' });
      res.end((topics.get(parts[0]) || []).map(m => JSON.stringify(m)).join('\n') + '\n'); return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, seen, topics, close: () => srv.close() })));
}

// Every way a secret could show up in captured bytes: as text, or base64'd at any of the 3 alignments.
function leakForms(s) {
  const b = Buffer.from(s); const out = [b];
  for (let i = 0; i < 3; i++) { const t = Buffer.from(b.subarray(i)).toString('base64').replace(/=+$/, ''); if (t.length > 8) { out.push(Buffer.from(t.slice(1, -2))); out.push(Buffer.from(t.slice(1, -2).replace(/\+/g, '-').replace(/\//g, '_'))); } }
  return out;
}
function findLeaks(blobs, secrets) {
  const all = Buffer.concat(blobs.map(b => Buffer.from(b)));
  const found = [];
  for (const s of secrets) for (const f of leakForms(s)) if (f.length >= 6 && all.includes(f)) { found.push(s); break; }
  return { found, bytes: all.length };
}
function readCfLog(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(x => ({ dir: x.dir, data: Buffer.from(x.b64, 'base64') })); } catch { return []; }
}
module.exports = { fakeNtfy, findLeaks, leakForms, readCfLog, FAKE_CF: path.join(__dirname, '_fake-cloudflared.js') };
