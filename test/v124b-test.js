// v0.12.4: a request too big for the provider (HTTP 413) is shrunk and retried instead of failing.
const http = require('http'); const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };
const { Store } = require('../src/store'); const { Agent } = require('../src/agent');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
const wait = (fn, ms = 8000) => new Promise((r, x) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); r(); } else if (Date.now() - t0 > ms) { clearInterval(t); x(new Error('timeout')); } }, 30); });
const sizes = [];
const CAP = 400000;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
  sizes.push(b.length);
  if (b.length > CAP) { res.writeHead(413, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `The request body is larger than ${CAP} bytes.`, type: 'invalid_request_error', code: 'request_too_large' } })); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'got it' } }] }) + '\n\ndata: [DONE]\n\n'); res.end();
}); });
srv.listen(0, async () => {
  // unit: fitMessages
  const big = 'data:image/png;base64,' + 'A'.repeat(900000);
  const ms = [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'old pic' }, { type: 'image_url', image_url: { url: big } }] }, { role: 'tool', content: 'x'.repeat(300000), tool_call_id: 't' }, { role: 'user', content: [{ type: 'text', text: 'new pic' }, { type: 'image_url', image_url: { url: big } }] }];
  const f1 = Agent.fitMessages(ms, 1400000);
  assert(typeof f1[1].content === 'string' && Array.isArray(f1[3].content), 'older image dropped first, newest kept when it fits');
  const f2 = Agent.fitMessages(ms, 100000);
  assert(JSON.stringify(f2).length <= 100000 && /Image removed/.test(f2[3].content) && /new pic/.test(f2[3].content), 'squeezed under the limit, request text kept');
  assert(Array.isArray(ms[3].content), 'original messages untouched');

  // integration: provider rejects with 413, Orbit retries smaller and answers
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-413-')); const store = new Store(dir, null);
  store.saveSettings({ baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'm', apiKey: 'sk', backupModels: [] });
  const events = []; const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });
  agent.handleUser('what is in this picture?', [{ dataUrl: big, name: 'p.png' }]);
  await wait(() => events.some(e => e.type === 'busy' && !e.busy));
  const end = events.filter(e => e.type === 'assistant_end' && !e.interim).pop();
  assert(end && end.text === 'got it', 'answered after the 413: ' + (end && end.text) + ' ' + JSON.stringify(events.filter(e => e.type === 'error')));
  assert(sizes.length === 2 && sizes[0] > CAP && sizes[1] <= CAP, 'one oversized try, then one that fits: ' + sizes.join(','));
  assert(!events.some(e => e.type === 'error'), 'no error shown');
  console.log('\nall 413 checks passed'); srv.close(); process.exit(0);
});
