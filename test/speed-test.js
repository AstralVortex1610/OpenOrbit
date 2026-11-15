// v0.12.3 speed: requests keep a stable prefix across a task's steps (so providers' prompt caches hit),
// read-only tool calls run together, "quick" thinking is sent and dropped when a provider rejects it,
// and every step is timed in perf.log.
const http = require('http'); const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };
const { Store } = require('../src/store'); const { Agent } = require('../src/agent');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };

// 1. Stable window: a 60-step task, the prefix sent to the model changes only a few times.
{
  const t = [{ role: 'user', content: 'Build the dashboard', at: 1 }];
  const state = {}; let prev = null, changes = 0, maxTok = 0;
  for (let i = 0; i < 60; i++) {
    t.push({ role: 'assistant', content: null, at: 2 + i * 2, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'run', arguments: '{}' } }] });
    t.push({ role: 'tool', tool_call_id: 'c' + i, name: 'run', content: 'x'.repeat(3000 + (i % 7) * 500), at: 3 + i * 2 });
    const out = Agent.compactContext(t, { max: 50, budget: 12000, state });
    const tok = Math.ceil(JSON.stringify(out).length / 4); maxTok = Math.max(maxTok, tok);
    if (prev) { const keep = JSON.stringify(prev.slice(0, prev.length)); const now = JSON.stringify(out.slice(0, prev.length)); if (keep !== now) changes++; }
    prev = out;
    if (out[0].content !== 'Build the dashboard') assert(false, 'request pinned at step ' + i);
  }
  let base = 0, bp = null; const t2 = t.slice(0, 1);
  for (let i = 1; i < t.length; i += 2) { t2.push(t[i], t[i + 1]); const o = Agent.compactContext(t2, { max: 50, budget: 12000 }); if (bp && JSON.stringify(bp) !== JSON.stringify(o.slice(0, bp.length))) base++; bp = o; }
  console.log('prefix changes over 60 steps:', changes, '(before: ' + base + ') max tokens', maxTok);
  assert(changes <= 12 && changes < base / 3, 'prefix stays the same on most steps (' + changes + ' changes in 60)');
  assert(maxTok < 12000 * 1.25, 'still within budget');
}

// 2. Live: system prompt identical across steps, quick thinking sent then dropped, parallel reads, perf.log
const bodies = []; let rejectEffort = true;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
  const j = JSON.parse(b); bodies.push(j);
  if (j.reasoning_effort && rejectEffort) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Invalid request' } })); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const n = j.messages.filter(m => m.role === 'tool').length;
  const delta = n < 6 ? { tool_calls: [0, 1, 2].map(k => ({ index: k, id: 'r' + n + k, function: { name: 'memory_list', arguments: '{}' } })) } : { content: 'done' };
  setTimeout(() => { res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 800 } } }) + '\n\ndata: [DONE]\n\n'); res.end(); }, 60);
}); });
const wait = (fn, ms = 8000) => new Promise((r, x) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); r(); } else if (Date.now() - t0 > ms) { clearInterval(t); x(new Error('timeout')); } }, 30); });
srv.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-speed-')); const store = new Store(dir, null);
  store.saveSettings({ baseUrl: base, model: 'm1', apiKey: 'k' });
  assert(store.getSettings().chatThinking === 'quick', 'chat thinks quickly by default');
  const events = []; const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });
  const starts = []; const orig = agent.tools.memory_list; agent.tools.memory_list = async (a) => { starts.push(Date.now()); await new Promise(r => setTimeout(r, 300)); return 'none'; };
  agent.handleUser('hi', []);
  await wait(() => events.some(e => e.type === 'busy' && !e.busy));
  const ok = bodies.filter(b => !b.reasoning_effort);
  assert(bodies[0].reasoning_effort === 'low', 'quick thinking sent as reasoning_effort low');
  assert(bodies.filter(b => b.reasoning_effort).length === 1, 'rejected once, then remembered and never sent again');
  const sys = new Set(ok.map(b => b.messages[0].content));
  assert(ok.length >= 3 && sys.size === 1, 'system prompt identical on every step of the task (' + ok.length + ' steps)');
  for (let i = 1; i < ok.length; i++) { const a = JSON.stringify(ok[i - 1].messages), b = JSON.stringify(ok[i].messages.slice(0, ok[i - 1].messages.length)); assert(a === b, `step ${i + 1} starts exactly like step ${i}`); }
  const spread = Math.max(...starts.slice(0, 3)) - Math.min(...starts.slice(0, 3));
  assert(starts.length >= 3 && spread < 150, 'three read-only calls ran at the same time');
  const log = fs.readFileSync(path.join(dir, 'perf.log'), 'utf8').trim().split('\n');
  assert(log.length >= 3 && /main m1 step \d+ms first \d+ms in 900 cached 800/.test(log[log.length - 1]), 'perf.log: ' + log[log.length - 1]);
  // a provider that accepts it keeps getting it
  rejectEffort = false; agent._noEffort.clear(); bodies.length = 0; events.length = 0;
  store.saveSettings({ chatThinking: 'default' }); agent.handleUser('again', []);
  await wait(() => events.some(e => e.type === 'busy' && !e.busy));
  assert(bodies.every(b => !('reasoning_effort' in b)), 'Model default sends nothing');
  console.log('PASS speed-test'); srv.close(); process.exit(0);
});
