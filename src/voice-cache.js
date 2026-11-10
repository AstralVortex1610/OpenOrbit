// Orbit Voice — local model cache. A tiny server on 127.0.0.1 that the voice workers load models
// through: the first time it downloads from Hugging Face / jsDelivr and keeps a copy in Orbit's data
// folder, after that it serves straight from disk, so the voice works offline.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const UPSTREAM = { hf: process.env.ORBIT_HF_HOST || 'https://huggingface.co/', cdn: process.env.ORBIT_CDN_HOST || 'https://cdn.jsdelivr.net/' };
const TYPES = { '.json': 'application/json', '.wasm': 'application/wasm', '.mjs': 'text/javascript', '.js': 'text/javascript', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.txt': 'text/plain' };

class VoiceCache {
  constructor(dir, onProgress) { this.dir = dir; this.onProgress = onProgress || (() => {}); this.server = null; this.port = 0; this.inflight = new Map(); }

  get base() { return `http://127.0.0.1:${this.port}`; }

  start() {
    if (this.server) return Promise.resolve(this.base);
    fs.mkdirSync(this.dir, { recursive: true });
    this.server = http.createServer((req, res) => this._handle(req, res).catch(e => { try { res.writeHead(502, this._cors()); res.end(String(e.message)); } catch {} }));
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.base); }));
  }
  stop() { if (this.server) this.server.close(); this.server = null; }

  _cors(extra = {}) { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': 'Content-Length', 'Cross-Origin-Resource-Policy': 'cross-origin', ...extra }; }

  sizeOnDisk() {
    let n = 0;
    const walk = (d) => { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p); st.isDirectory() ? walk(p) : (n += st.size); } };
    walk(this.dir); return n;
  }

  async _handle(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, this._cors()); return res.end(); }
    const m = req.url.match(/^\/(hf|cdn)\/(.+)$/);
    if (!m) { res.writeHead(404, this._cors()); return res.end(); }
    const rel = decodeURIComponent(m[2].split('?')[0]);
    if (rel.includes('..')) { res.writeHead(400, this._cors()); return res.end(); }
    const file = path.join(this.dir, m[1], rel);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (fs.existsSync(file)) {
      res.writeHead(200, this._cors({ 'Content-Type': type, 'Content-Length': fs.statSync(file).size }));
      return fs.createReadStream(file).pipe(res);
    }
    // Someone else is already downloading it: wait, then serve from disk.
    if (this.inflight.has(file)) { await this.inflight.get(file).catch(() => {}); return this._handle(req, res); }
    let done;
    this.inflight.set(file, new Promise((r) => (done = r)));
    try {
      const up = await fetch(UPSTREAM[m[1]] + m[2], { redirect: 'follow' });
      if (!up.ok) { res.writeHead(up.status, this._cors()); res.end(); return; }
      // fetch() un-gzips for us, so a compressed Content-Length is no use for the real size.
      const total = up.headers.get('content-encoding') ? 0 : (Number(up.headers.get('content-length')) || 0);
      res.writeHead(200, this._cors({ 'Content-Type': type, ...(total ? { 'Content-Length': total } : {}) }));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.part';
      const out = fs.createWriteStream(tmp);
      let loaded = 0, last = 0;
      for await (const chunk of Readable.fromWeb(up.body)) {
        loaded += chunk.length;
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        res.write(chunk);
        if (total > 2e6 && Date.now() - last > 250) { last = Date.now(); this.onProgress({ file: rel, loaded, total }); }
      }
      await new Promise((r, j) => out.end(err => (err ? j(err) : r())));
      if (!total || loaded === total) fs.renameSync(tmp, file); else fs.rmSync(tmp, { force: true });
      if (total > 2e6) this.onProgress({ file: rel, loaded, total, done: true });
      res.end();
    } finally { this.inflight.delete(file); done(); }
  }
}

module.exports = { VoiceCache };
