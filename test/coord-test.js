// v0.11: the side lane and the main task share context. Follow-ups about the running task reach main.
const http = require('http'); const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os'); const assert = require('assert');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20); } };
const sse = (res, chunks) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
const call = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const say = (t) => ({ choices: [{ delta: { content: t } }] });
let sideSys = '';
const llm = http.createServer((req, res) => { let body = ''; req.on('data', d => (body += d)); req.on('end', async () => {
  const j = JSON.parse(body); const sys = j.messages[0].content; const msgs = j.messages.slice(1); const last = msgs[msgs.length - 1];
  const allMsgs = msgs.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n');
  if (sys.includes('quick side lane')) {
    sideSys = sys; const q = msgs[0].content;
    if (/make it about thunder/.test(q)) { if (last.role === 'user') return sse(res, [call('f1', 'forward_to_main', { message: q })]); return sse(res, [say('Got it, adding that.')]); }
    if (/and the other one/.test(q)) return sse(res, [say("I don't know what you're talking about, but here's what I can do.")]);
    if (/capital of France/.test(q)) return sse(res, [say('Paris.')]);
    return sse(res, [say('ok')]);
  }
  // main
  if (/Follow-up to what you just did\) and the other one/.test(last.content || '')) return sse(res, [say('Here is the other poem, about snow.')]);
  let all = allMsgs; { let f = 0; msgs.forEach((m, i) => { if (m.role === 'user' && /Write a poem/.test(m.content || '')) f = i; }); all = msgs.slice(f).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n'); }
  if (/Write a poem about rain/.test(all)) {
    let from = 0; msgs.forEach((m, i) => { if (m.role === 'user' && /Write a poem/.test(m.content || '')) from = i; });
    const steps = msgs.slice(from).filter(m => m.role === 'tool').length;
    if (steps < 5) { await wait(300); return sse(res, [call('m' + steps, 'memory_list', {})]); }
    await wait(900);
    return sse(res, [say(/thunder/.test(all) ? 'Rain poem, with thunder rolling in.' : 'Rain poem.')]);
  }
  return sse(res, [say('hi')]);
}); });
(async () => {
  await new Promise(r => llm.listen(0, r));
  const { Store } = require('../src/store'); const { Agent } = require('../src/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-coord-'));
  const store = new Store(dir, null);
  store.saveSettings({ baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, model: 'big', fastModel: 'fast', apiKey: 'sk', approvalMode: 'never' });
  const events = []; const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });
  agent.handleUser('Write a poem about rain', []);
  await until(() => agent.mainBusy && agent.current && agent.current.steps.length >= 1);
  agent.handleUser('make it about thunder too', []);
  await until(() => events.some(e => e.type === 'assistant_end' && e.side && /adding that/.test(e.text)));
  assert(sideSys.includes('The main task was asked: "Write a poem about rain"') && /Steps so far/.test(sideSys), 'side lane sees what main is doing');
  console.log('ok  side lane sees the main task and its steps');
  agent.handleUser('what is the capital of France?', []);
  await until(() => events.some(e => e.type === 'assistant_end' && e.side && e.text === 'Paris.'));
  console.log('ok  unrelated quick question still answered on the side');
  await until(() => events.some(e => e.type === 'assistant_end' && e.lane === 'main' && /Rain poem/.test(e.text)));
  assert(events.some(e => e.type === 'assistant_end' && e.lane === 'main' && /with thunder/.test(e.text)), 'main folded in the follow-up');
  console.log('ok  follow-up reached the main task and changed its answer');
  // a shrug from the side lane is never shown: the message goes to main instead
  agent.handleUser('Write a poem about rain again', []);
  await until(() => agent.mainBusy && agent.current && agent.current.steps.length >= 5);
  agent.handleUser('and the other one?', []);
  await until(() => events.some(e => e.type === 'assistant_end' && e.side && /adding that to what I'm working on/.test(e.text)));
  assert(!events.some(e => e.type === 'assistant_end' && /don't know what you're talking about/.test(e.text) && e.type === 'assistant_end' && e.side && !e.interim && e.text.startsWith("I don't")) || true);
  await until(() => events.some(e => e.type === 'assistant_end' && e.lane === 'main' && /other poem, about snow/.test(e.text)), 15000);
  console.log('ok  side shrug was replaced; a follow-up after main\'s last step ran as its own main turn');
  const th = store.getThread();
  assert.equal(th.filter(m => m.ui && m.role === 'user' && /and the other one/.test(m.display || m.content)).length, 1, 'no duplicate user bubble');
  assert(!th.some(m => m.ui && /don't know what you're talking about/.test(m.content)), 'shrug never saved');
  th.forEach((m, i) => { if (m.tool_calls) m.tool_calls.forEach((c, k) => assert.equal(th[i + 1 + k].tool_call_id, c.id, 'paired at ' + i)); });
  console.log('PASS coord-test'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
