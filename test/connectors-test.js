// MCP (stdio + HTTP) and custom API connectors.
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { Store } = require('../src/store'); const { Connectors } = require('../src/connectors');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
(async () => {
  // HTTP MCP server (streamable HTTP, SSE replies) + a plain REST API
  let session = null; let apiSeen = null;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      if (req.url.startsWith('/mcp')) {
        const m = JSON.parse(body || '{}');
        if (m.method === 'initialize') { session = 'sess-1'; res.setHeader('Mcp-Session-Id', session); }
        else if (req.headers['mcp-session-id'] !== session) { res.writeHead(400); return res.end('no session'); }
        if (m.id == null) { res.writeHead(202); return res.end(); }
        const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : m.method === 'tools/list' ? { tools: [{ name: 'search_docs', description: 'Search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] } : { content: [{ type: 'text', text: 'found ' + m.params.arguments.q + ' auth=' + req.headers.authorization }] };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
      }
      apiSeen = { method: req.method, url: req.url, auth: req.headers.authorization, body };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  }).listen(0);
  const port = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cx-'));
  const store = new Store(dir, null);
  store.saveSettings({
    mcpServers: [
      { name: 'Mock Notes', type: 'stdio', command: process.execPath, args: `"${path.join(__dirname, '_mock-mcp.js')}"`, env: { SECRET: 's3cret' } },
      { name: 'Remote Docs', type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer tok' } },
    ],
    apiConnectors: [{ name: 'My API', baseUrl: `http://127.0.0.1:${port}/v1`, auth: 'bearer', apiKey: 'k-123', description: 'Test API' }],
  });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert(!JSON.stringify(raw).includes('s3cret') && !JSON.stringify(raw).includes('k-123') && raw.mcpServers[0].secretEnc, 'secrets are not stored in plain text');
  const ui = store.getSettingsForUI();
  assert(ui.mcpServers[0].envKeys[0] === 'SECRET' && !ui.mcpServers[0].env && ui.apiConnectors[0].hasKey && !ui.apiConnectors[0].apiKey, 'UI sees key names only');
  const cx = new Connectors(store);
  await cx.restart();
  const names = cx.schemas().map(s => s.function.name).sort();
  console.log(names.join(', '));
  assert(names.includes('mcp_mock_notes__echo') && names.includes('mcp_mock_notes__create_note') && names.includes('mcp_remote_docs__search_docs') && names.includes('api_my_api'), 'all connector tools registered');
  assert(cx.isReadOnly('mcp_mock_notes__echo') && !cx.isReadOnly('mcp_mock_notes__create_note'), 'read-only vs write detection');
  let asked = 0; const approve = async () => { asked++; return true; };
  let r = await cx.call('mcp_mock_notes__echo', { text: 'hi' }, approve, 'risky');
  assert(r === 'echo:{"text":"hi"}:s3cret' && asked === 0, 'stdio MCP call with encrypted env, no approval for reads');
  r = await cx.call('mcp_mock_notes__create_note', { title: 'x' }, approve, 'risky');
  assert(asked === 1 && r.startsWith('create_note'), 'write tool asks first');
  r = await cx.call('mcp_mock_notes__create_note', { title: 'x' }, async () => false, 'risky');
  assert(/declined/.test(r), 'declined write does not run');
  r = await cx.call('mcp_remote_docs__search_docs', { q: 'orbit' }, approve, 'never');
  assert(r === 'found orbit auth=Bearer tok', 'HTTP MCP with session + SSE + headers');
  r = await cx.call('api_my_api', { path: '/repos', query: { per_page: 2 } }, approve, 'risky');
  assert(/HTTP 200/.test(r) && apiSeen.url === '/v1/repos?per_page=2' && apiSeen.auth === 'Bearer k-123', 'API GET with bearer key');
  asked = 0; r = await cx.call('api_my_api', { method: 'POST', path: '/issues', body: { t: 1 } }, approve, 'risky');
  assert(asked === 1 && apiSeen.method === 'POST' && apiSeen.body === '{"t":1}', 'API POST asks first');
  // turning one off removes its tools
  const s = store.getSettings(); store.saveSettings({ mcpServers: s.mcpServers.map(m => ({ ...m, enabled: m.name !== 'Mock Notes' })) });
  await cx.restart();
  assert(!cx.has('mcp_mock_notes__echo') && cx.has('mcp_remote_docs__search_docs'), 'disabling a server drops its tools');
  const st = cx.status(); assert(st.mcp.find(m => m.name === 'Remote Docs').status === 'connected', 'status reports connected');
  // tools proxy in buildTools routes connector tools
  const { buildTools, allSchemas } = require('../src/tools');
  const agent = { store, connectors: cx, requestApproval: async () => true, emit() {}, google: { connected: () => false } };
  const tools = buildTools(agent, { id: 'main' });
  r = await tools.mcp_remote_docs__search_docs({ q: 'proxy' });
  assert(/found proxy/.test(r) && allSchemas(agent).some(t => t.function.name === 'api_my_api'), 'agent tools reach connectors');
  cx.stopAll(); srv.close(); console.log('PASS connectors-test'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
