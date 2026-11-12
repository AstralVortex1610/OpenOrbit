// Orbit — connectors: any MCP server (stdio command or HTTP URL) and custom HTTP APIs.
// Their tools join Orbit's own, named mcp_<server>__<tool> and api_<name>.
const { spawn } = require('child_process');

const slug = (s, n = 24) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, n) || 'x';
const PROTOCOL = '2025-06-18';
const WRITEY = /(send|create|delete|remove|update|write|post|put|patch|edit|move|rename|pay|book|buy|order|publish|merge|push|close|archive|invite|share|upload|insert|set_|add_|drop)/i;

const API_PRESETS = {
  github: { name: 'GitHub', baseUrl: 'https://api.github.com', auth: 'bearer', description: 'GitHub REST API: repos, issues, pull requests, code search, notifications, releases.', keyHint: 'A fine-grained personal access token from github.com/settings/tokens' },
  notion: { name: 'Notion', baseUrl: 'https://api.notion.com/v1', auth: 'bearer', headers: { 'Notion-Version': '2022-06-28' }, description: 'Notion API: search pages and databases, read and append blocks, query databases.', keyHint: 'An internal integration secret from notion.so/my-integrations (share pages with it)' },
  slack: { name: 'Slack', baseUrl: 'https://slack.com/api', auth: 'bearer', description: 'Slack Web API: conversations.list, conversations.history, chat.postMessage, search.messages (method names as the path).', keyHint: 'A bot or user token (xoxb-… / xoxp-…) from api.slack.com/apps' },
  linear: { name: 'Linear', baseUrl: 'https://api.linear.app', auth: 'raw', description: 'Linear GraphQL API at path /graphql: POST {"query": "..."} for issues, projects, teams.', keyHint: 'A personal API key from Linear settings' },
};

// ---------------- MCP client ----------------
class McpClient {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.nextId = 1; this.pending = new Map(); this.tools = []; this.status = 'starting'; this.error = ''; this.session = null; }

  async start() {
    if (this.cfg.type === 'http') {
      await this._rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Orbit', version: '0.10' } });
      await this._notify('notifications/initialized');
    } else {
      const env = { ...process.env, ...(this.cfg.env || {}) };
      const args = Array.isArray(this.cfg.args) ? this.cfg.args : String(this.cfg.args || '').match(/"[^"]*"|\S+/g)?.map(a => a.replace(/^"|"$/g, '')) || [];
      this.proc = spawn(this.cfg.command, args, { env, shell: process.platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      this.proc.stdout.on('data', (d) => {
        buf += d.toString('utf8'); let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this._onMessage(line); }
      });
      this.proc.stderr.on('data', (d) => { this.stderr = (String(this.stderr || '') + d).slice(-2000); });
      this.proc.on('exit', (code) => { this.status = 'stopped'; this.error = this.error || `exited (code ${code})${this.stderr ? ': ' + this.stderr.trim().split('\n').pop() : ''}`; for (const p of this.pending.values()) p.reject(new Error('MCP server stopped')); this.pending.clear(); });
      this.proc.on('error', (e) => { this.status = 'error'; this.error = e.message; });
      await this._rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Orbit', version: '0.10' } }, 30000);
      this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
    const tools = []; let cursor;
    do { const r = await this._rpc('tools/list', cursor ? { cursor } : {}); tools.push(...(r.tools || [])); cursor = r.nextCursor; } while (cursor && tools.length < 200);
    this.tools = tools; this.status = 'connected'; this.error = '';
    return tools;
  }

  stop() { try { if (this.proc) this.proc.kill(); } catch {} this.proc = null; this.status = 'stopped'; }

  _send(msg) { this.proc.stdin.write(JSON.stringify(msg) + '\n'); }
  _onMessage(line) {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id != null && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || 'MCP error')) : p.resolve(m.result || {}); }
    else if (m.id != null && m.method) this._send({ jsonrpc: '2.0', id: m.id, result: {} }); // pings etc.
  }
  async _notify(method) {
    if (this.cfg.type !== 'http') return this._send({ jsonrpc: '2.0', method });
    await fetch(this.cfg.url, { method: 'POST', headers: this._httpHeaders(), body: JSON.stringify({ jsonrpc: '2.0', method }) }).catch(() => {});
  }
  _httpHeaders() { return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL, ...(this.session ? { 'Mcp-Session-Id': this.session } : {}), ...(this.cfg.headers || {}) }; }
  async _rpc(method, params, timeout = 60000) {
    const id = this.nextId++;
    if (this.cfg.type === 'http') {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(this.cfg.url, { method: 'POST', headers: this._httpHeaders(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: ctrl.signal });
        const sid = r.headers.get('mcp-session-id'); if (sid) this.session = sid;
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        const ct = r.headers.get('content-type') || '';
        let msg;
        if (ct.includes('text/event-stream')) {
          const text = await r.text();
          for (const chunk of text.split(/\n\n/)) {
            const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
            if (!data) continue; try { const j = JSON.parse(data); if (j.id === id) msg = j; } catch {}
          }
        } else msg = await r.json();
        if (!msg) throw new Error('No reply from the MCP server.');
        if (msg.error) throw new Error(msg.error.message || 'MCP error');
        return msg.result || {};
      } finally { clearTimeout(t); }
    }
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('MCP server is not running.'));
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async call(name, args) {
    const r = await this._rpc('tools/call', { name, arguments: args || {} }, 180000);
    const parts = []; let image = null;
    for (const c of r.content || []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image' && !image) image = `data:${c.mimeType || 'image/png'};base64,${c.data}`;
      else if (c.type === 'resource' && c.resource) parts.push(c.resource.text || `[resource ${c.resource.uri}]`);
      else if (c.type === 'resource_link') parts.push(`[${c.name || 'link'}] ${c.uri}`);
    }
    if (r.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent, null, 1));
    const text = (r.isError ? 'Error: ' : '') + (parts.join('\n') || '(no output)');
    return image ? { text, image } : text;
  }
}

// ---------------- registry ----------------
class Connectors {
  constructor(store, log = () => {}) {
    this.store = store; this.log = log;
    this.clients = new Map();   // server id -> McpClient
    this.tools = new Map();     // tool name -> { kind, schema, server?, remote?, api?, write }
    this.state = new Map();     // server id -> { status, error, tools }
    this.onChange = () => {};
  }

  schemas() { return [...this.tools.values()].map(t => t.schema); }
  has(name) { return this.tools.has(name); }
  isReadOnly(name) { const t = this.tools.get(name); return !!t && !t.write; }

  async restart() {
    const s = this.store.getSettings();
    const want = (s.mcpServers || []).filter(m => m.enabled !== false);
    const key = (m) => JSON.stringify([m.type, m.command, m.args, m.url, m.env, m.headers]);
    for (const [id, c] of this.clients) { const m = want.find(x => x.id === id); if (!m || key(m) !== c.key) { c.stop(); this.clients.delete(id); this.state.delete(id); } }
    this._rebuild();
    await Promise.all(want.filter(m => !this.clients.has(m.id)).map(async (m) => {
      const c = new McpClient(m, this.log); c.key = key(m); this.clients.set(m.id, c);
      this.state.set(m.id, { status: 'starting', error: '', tools: 0 });
      this.onChange();
      try { await c.start(); this.state.set(m.id, { status: 'connected', error: '', tools: c.tools.length }); }
      catch (e) { c.stop(); this.state.set(m.id, { status: 'error', error: c.error || e.message, tools: 0 }); this.log(`mcp ${m.name}: ${e.message}`); }
      this._rebuild(); this.onChange();
    }));
    this._rebuild(); this.onChange();
  }

  stopAll() { for (const c of this.clients.values()) c.stop(); this.clients.clear(); }

  _rebuild() {
    const s = this.store.getSettings();
    this.tools.clear();
    for (const m of (s.mcpServers || [])) {
      const c = this.clients.get(m.id); if (!c || c.status !== 'connected') continue;
      for (const t of c.tools.slice(0, 60)) {
        const name = `mcp_${slug(m.name, 18)}__${slug(t.name, 38)}`.slice(0, 64);
        const ann = t.annotations || {};
        const write = ann.readOnlyHint === true ? false : (ann.destructiveHint === true || WRITEY.test(t.name));
        const params = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        this.tools.set(name, { kind: 'mcp', server: m.id, serverName: m.name, remote: t.name, write, schema: { type: 'function', function: { name, description: `[${m.name} via MCP] ${String(t.description || t.title || t.name).slice(0, 900)}`, parameters: params } } });
      }
    }
    for (const a of (s.apiConnectors || [])) {
      if (a.enabled === false || !a.baseUrl) continue;
      const name = `api_${slug(a.name, 30)}`;
      this.tools.set(name, { kind: 'api', api: a.id, write: null, schema: { type: 'function', function: {
        name, description: `Call the ${a.name} API (${a.baseUrl}). ${String(a.description || '').slice(0, 600)} Auth is added for you. GET to read; anything else changes data and needs the user's approval.`,
        parameters: { type: 'object', properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          path: { type: 'string', description: 'Path after the base URL, e.g. /user/repos' },
          query: { type: 'object', description: 'Query string parameters.' },
          body: { type: 'object', description: 'JSON body for POST/PUT/PATCH.' },
        }, required: ['path'] },
      } } });
    }
  }

  status() {
    const s = this.store.getSettings();
    return {
      mcp: (s.mcpServers || []).map(m => ({ id: m.id, name: m.name, enabled: m.enabled !== false, ...(this.state.get(m.id) || { status: m.enabled === false ? 'off' : 'starting', error: '', tools: 0 }), toolNames: [...this.tools.values()].filter(t => t.server === m.id).map(t => t.remote) })),
      api: (s.apiConnectors || []).map(a => ({ id: a.id, name: a.name, enabled: a.enabled !== false, tool: `api_${slug(a.name, 30)}` })),
    };
  }

  // approve(title, detail) -> Promise<bool>
  async call(name, args, approve, mode) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`${name} isn't connected right now.`);
    if (t.kind === 'mcp') {
      const c = this.clients.get(t.server);
      if (!c || c.status !== 'connected') throw new Error(`${t.serverName} isn't connected. Check it in Connectors.`);
      if (mode !== 'never' && (t.write || mode === 'always')) {
        const ok = await approve(`Use ${t.serverName}: ${t.remote}?`, JSON.stringify(args || {}, null, 1).slice(0, 900));
        if (!ok) return 'The user declined this action.';
      }
      return c.call(t.remote, args);
    }
    const a = (this.store.getSettings().apiConnectors || []).find(x => x.id === t.api);
    if (!a) throw new Error('That API connector was removed.');
    const method = String(args.method || 'GET').toUpperCase();
    if (method !== 'GET' && mode !== 'never') {
      const ok = await approve(`${method} to ${a.name}?`, `${args.path}\n${args.body ? JSON.stringify(args.body, null, 1).slice(0, 800) : ''}`);
      if (!ok) return 'The user declined this request.';
    }
    const url = new URL(String(a.baseUrl).replace(/\/+$/, '') + '/' + String(args.path || '').replace(/^\/+/, ''));
    for (const [k, v] of Object.entries(args.query || {})) url.searchParams.set(k, String(v));
    const headers = { Accept: 'application/json', ...(a.headers || {}) };
    if (a.apiKey) {
      if (a.auth === 'header' && a.authHeader) headers[a.authHeader] = a.apiKey;
      else if (a.auth === 'raw') headers.Authorization = a.apiKey;
      else if (a.auth === 'query' && a.authHeader) url.searchParams.set(a.authHeader, a.apiKey);
      else headers.Authorization = `Bearer ${a.apiKey}`;
    }
    if (args.body && method !== 'GET') headers['Content-Type'] = 'application/json';
    if (/api\.github\.com/.test(url.host)) headers['User-Agent'] = 'Orbit';
    const r = await fetch(url, { method, headers, body: args.body && method !== 'GET' ? JSON.stringify(args.body) : undefined });
    let text = await r.text();
    try { text = JSON.stringify(JSON.parse(text), null, 1); } catch {}
    return `${r.ok ? '' : 'Error: '}HTTP ${r.status}\n${text.slice(0, 12000)}`;
  }
}

module.exports = { Connectors, McpClient, API_PRESETS };
