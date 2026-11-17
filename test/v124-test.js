// v0.12.4: no Orbiter handoff unless asked; replies that claim work they didn't do get sent back;
// Orbiter questions survive a reload; reports show in chat; messages can be edited.
const http = require('http'); const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };
const { Store } = require('../src/store'); const { Agent } = require('../src/agent'); const { buildTools } = require('../src/tools');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
const wait = (fn, ms = 8000) => new Promise((r, x) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); r(); } else if (Date.now() - t0 > ms) { clearInterval(t); x(new Error('timeout')); } }, 30); });

// scripted model: each request takes the next reply
let script = []; const bodies = [];
const sse = (res, d) => res.write('data: ' + JSON.stringify({ choices: [{ delta: d }] }) + '\n\n');
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
  bodies.push(JSON.parse(b)); const next = script.shift() || { text: 'ok' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (next.tool) sse(res, { tool_calls: [{ index: 0, id: 'c' + bodies.length, type: 'function', function: { name: next.tool, arguments: JSON.stringify(next.args || {}) } }] });
  else sse(res, { content: next.text });
  res.write('data: [DONE]\n\n'); res.end();
}); });

srv.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-124-')); const store = new Store(dir, null);
  store.saveSettings({ baseUrl: base, model: 'm', apiKey: 'sk', backupModels: [] });
  const events = []; const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });

  // ---- reply checks ----
  const C = Agent.checkReply;
  assert(C("I've fixed the button colour.", { acted: 0, lastUser: 'fix the button colour' }), 'claims a fix with no change: sent back');
  assert(!C("I've fixed the button colour.", { acted: 2, lastUser: 'fix the button colour' }), 'claims a fix after real edits: fine');
  assert(!C("No change needed: it's already done that way.", { acted: 0, lastUser: 'fix the button colour' }), 'honest "already done": fine');
  assert(!C('React is a UI library.', { acted: 0, lastUser: 'what is react' }), 'plain answer: fine');
  assert(C('Before I start, let me ask you a few questions.', { acted: 0, lastUser: 'build me an app' }), 'says it will ask but asks nothing: sent back');
  assert(!C('Which stack do you want: React or Svelte?', { acted: 0, lastUser: 'build me an app' }), 'asks a real question: fine');
  assert(C('Read the files. Now I\'ll update the header.', { acted: 0, lastUser: 'update the header' }), 'ends on "now I\'ll…" and stops: sent back');
  assert(!C('All done. Let me know if you want anything else.', { acted: 1, lastUser: 'update the header' }), '"let me know" is not an unfinished step');

  // the loop really sends it back and the model finishes the job
  script = [{ text: "I've updated the file." }, { tool: 'write_file', args: { path: path.join(dir, 'x.txt'), content: 'hi' } }, { text: 'Updated x.txt.' }];
  store.saveSettings({ approvalMode: 'never' });
  agent.handleUser('update x.txt to say hi', []);
  await wait(() => events.some(e => e.type === 'busy' && !e.busy));
  assert(fs.existsSync(path.join(dir, 'x.txt')), 'after the check, the model actually wrote the file');
  const fin = events.filter(e => e.type === 'assistant_end' && !e.interim).pop();
  assert(fin && fin.text === 'Updated x.txt.', 'final reply is the honest one: ' + (fin && fin.text));
  assert(events.some(e => e.type === 'stream_reset'), 'the false "updated" reply was taken off screen');
  const hiddenNote = store.getThread().find(m => m.hidden && /Check: your reply says the work is done/.test(m.content));
  assert(hiddenNote, 'check-in kept hidden from the user');

  // ---- Orbiter handoff gate ----
  const sys = agent._systemPrompt('main');
  assert(/Never hand work to Orbiter and never suggest it unless the user asks for Orbiter by name/.test(sys), 'prompt: no handoff by default');
  assert(!/say in one line that Orbiter will do it better/.test(sys), 'old "Orbiter will do it better" rule gone');
  agent.orbiter = { statusText: () => '', session: () => null, createSession: () => ({ id: 's1', name: 'x', folder: dir, tier: '', mode: 'ask' }), send: async () => {} };
  const tools = buildTools(agent, { id: 'main' });
  store.saveThread([{ role: 'user', content: 'refactor the auth module', ui: true, id: 'u1' }]);
  let r = await tools.orbiter_handoff({ task: 'refactor' }).catch(e => 'Error: ' + e.message);
  assert(/^Error: Not handed off/.test(r), 'coding request without Orbiter: refused');
  store.saveThread([{ role: 'user', content: "don't hand this to Orbiter, just refactor it", ui: true, id: 'u2' }]);
  r = await tools.orbiter_handoff({ task: 'refactor' }).catch(e => 'Error: ' + e.message);
  assert(/^Error: Not handed off/.test(r), '"don\'t hand to Orbiter": refused');
  store.saveThread([{ role: 'user', content: 'use Orbiter for this refactor', ui: true, id: 'u3' }]);
  r = await tools.orbiter_handoff({ task: 'refactor' }).catch(e => 'Error: ' + e.message);
  assert(/^Handed to Orbiter/.test(r), 'asked for Orbiter by name: handed off');
  store.saveSettings({ orbiterHandoffMode: 'suggest' });
  assert(/may OFFER Orbiter/.test(agent._systemPrompt('main')), 'suggest mode: offers, waits for yes');
  store.saveThread([{ role: 'user', content: 'yes go ahead', ui: true, id: 'u4' }]);
  r = await tools.orbiter_handoff({ task: 'refactor' }).catch(e => 'Error: ' + e.message);
  assert(/^Handed to Orbiter/.test(r), 'suggest mode + yes: handed off');
  store.saveSettings({ orbiterHandoffMode: 'off' });
  agent.orbiter = null;

  // ---- side lane can't hand off, and instructions reach main ----
  const { SIDE } = (() => { const src = fs.readFileSync(path.join(__dirname, '../src/agent.js'), 'utf8'); return { SIDE: src.match(/const SIDE_TOOLS = new Set\(\[([^\]]*)\]/)[1] }; })();
  assert(!/orbiter_handoff/.test(SIDE), 'side lane has no handoff tool');
  agent.mainBusy = true; agent.current = { text: 'x', steps: [], at: Date.now() };
  script = [{ text: "Sure, I won't use Orbiter." }];
  await agent._side("don't hand it to Orbiter", 'app');
  assert(agent.pendingForMain.some(p => /don't hand it to Orbiter/.test(p.text)), 'side lane forwarded the instruction to main');
  agent.mainBusy = false; agent.current = null; agent.pendingForMain = []; agent.inbox = []; agent.deferred = [];

  // ---- open questions survive a reload ----
  const q = agent.askUser('Which folder?', ['src', 'app'], 'orb-abc');
  assert(agent.pendingAsks('orb-abc').length === 1 && agent.pendingAsks('orb-abc')[0].question === 'Which folder?', 'Orbiter question kept until answered');
  agent.pending.get(agent.pendingAsks('orb-abc')[0].id)({ answer: 'src' });
  assert((await q) === 'src' && agent.pendingAsks('orb-abc').length === 0, 'answered question cleared');

  // ---- reports in chat ----
  const rep = await tools.show_report({ title: 'Update', summary: 'All good', markdown: '## Hi\n- one' });
  assert(rep.report && rep.report.title === 'Update' && /<!--orbit-report /.test(rep.text), 'show_report returns an in-chat card');
  assert(/Only make a file \(make_file\) when the user asks for one/.test(agent._systemPrompt('main')), 'prompt: files only when asked');

  // ---- edit a message ----
  store.saveThread([{ role: 'user', content: 'first', ui: true, id: 'a1' }, { role: 'assistant', content: 'r1', ui: true }, { role: 'user', content: 'second', ui: true, id: 'a2' }, { role: 'assistant', content: 'r2', ui: true }]);
  events.length = 0; script = [{ text: 'redone' }];
  await agent.editMessage('main', 'a2', 'second, edited');
  await wait(() => events.some(e => e.type === 'busy' && !e.busy));
  const t = store.getThread().filter(m => m.ui).map(m => m.content);
  assert(JSON.stringify(t) === JSON.stringify(['first', 'r1', 'second, edited', 'redone']), 'edit cut the thread back and redid it: ' + JSON.stringify(t));
  assert(events.some(e => e.type === 'thread_reset' && e.scope === 'main'), 'UI told to redraw the chat');

  // ---- Orbiter thinks Quick by default ----
  assert(new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-124b-')), null).getSettings().orbiterThinking === 'quick', 'Orbiter defaults to Quick thinking');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-124c-')); fs.writeFileSync(path.join(d2, 'settings.json'), JSON.stringify({ model: 'm', orbiterThinking: 'default' }));
  assert(new Store(d2, null).getSettings().orbiterThinking === 'quick', 'old saved "Model default" moved to Quick once');
  const st3 = new Store(d2, null); st3.saveSettings({ orbiterThinking: 'deep' });
  assert(new Store(d2, null).getSettings().orbiterThinking === 'deep', 'a later choice sticks');

  console.log('\nall v0.12.4 checks passed'); srv.close(); process.exit(0);
});
