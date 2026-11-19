// Orbit Phone Link relay as a Cloudflare Worker + Durable Object, on YOUR Cloudflare account.
// Same protocol as ../server.js:  PC -> wss://<worker>/host/<room> (Bearer RELAY_TOKEN),  phone -> wss://<worker>/c/<room>.
// One Durable Object per room pairs the PC with its phones and copies sealed bytes. Nothing is stored.
//   npx wrangler secret put RELAY_TOKEN && npx wrangler deploy
const OP = { OPEN: 1, DATA: 2, CLOSE: 3 };
const ROOM = /^\/(host|c)\/([A-Za-z0-9_-]{16,64})$/;
function frame(op, id, payload) {
  const p = payload == null ? new Uint8Array(0) : typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload);
  const b = new Uint8Array(5 + p.length); b[0] = op; new DataView(b.buffer).setUint32(1, id >>> 0); b.set(p, 5); return b;
}
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    const m = url.pathname.match(ROOM);
    if (!m) return new Response('Orbit relay', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket only', { status: 426 });
    if (m[1] === 'host' && env.RELAY_TOKEN && !(await sameSecret((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env.RELAY_TOKEN))) return new Response('Unauthorized', { status: 401 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[2])).fetch(req);
  },
};

export class Room {
  constructor() { this.host = null; this.clients = new Map(); this.next = 1; }
  async fetch(req) {
    const kind = new URL(req.url).pathname.split('/')[1];
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    if (kind === 'host') this.onHost(ws); else this.onClient(ws, req.headers.get('CF-Connecting-IP') || '?');
    return new Response(null, { status: 101, webSocket: client });
  }
  onHost(ws) {
    if (this.host) { try { this.host.close(4000, 'replaced'); } catch {} for (const c of this.clients.values()) { try { c.close(4404, 'laptop reconnecting'); } catch {} } this.clients.clear(); }
    this.host = ws;
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') return;
      const b = new Uint8Array(ev.data); if (b.length < 5) return;
      const id = new DataView(b.buffer, b.byteOffset).getUint32(1); const c = this.clients.get(id); if (!c) return;
      if (b[0] === OP.DATA) { try { c.send(b.subarray(5)); } catch {} }
      else if (b[0] === OP.CLOSE) {
        let code = b.length >= 7 ? (b[5] << 8) | b[6] : 1000; if (code < 1000 || code >= 5000 || code === 1005 || code === 1006) code = 1000;
        this.clients.delete(id); try { c.close(code, b.length > 7 ? new TextDecoder().decode(b.subarray(7)).slice(0, 60) : 'closed by laptop'); } catch {}
      }
    });
    const gone = () => { if (this.host !== ws) return; this.host = null; for (const c of this.clients.values()) { try { c.close(4404, 'laptop offline'); } catch {} } this.clients.clear(); };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
  }
  onClient(ws, ip) {
    if (!this.host) { ws.close(4404, 'laptop offline'); return; }
    if (this.clients.size >= 8) { ws.close(1013, 'too many phones'); return; }
    const id = this.next++ >>> 0; this.clients.set(id, ws);
    try { this.host.send(frame(OP.OPEN, id, JSON.stringify({ ip }))); } catch {}
    ws.addEventListener('message', (ev) => { if (this.host && typeof ev.data !== 'string') { try { this.host.send(frame(OP.DATA, id, ev.data)); } catch {} } });
    const gone = () => { if (this.clients.get(id) !== ws) return; this.clients.delete(id); if (this.host) { try { this.host.send(frame(OP.CLOSE, id)); } catch {} } };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
  }
}
