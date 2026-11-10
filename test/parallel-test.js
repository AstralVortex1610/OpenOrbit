// v0.5: side lane while busy, parallel background tasks, stop, Google APIs, Netlify publish, image generation.
const http = require('http');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20); } };
const log = [];
const sse = (res, chunks) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
const call = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const calls = (list) => ({ choices: [{ delta: { tool_calls: list.map(([id, name, args], index) => ({ index, id, function: { name, arguments: JSON.stringify(args) } })) } }] });
const say = (t) => ({ choices: [{ delta: { content: t } }] });

let mainSawSide = false, mainSawCorrection = false;
const llm = http.createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', async () => {
    const u = req.url;
    if (u.endsWith('/images/generations')) { const j = JSON.parse(body); log.push(['image', j.model, j.prompt]); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] })); }
    const j = JSON.parse(body);
    const sys = j.messages[0].content;
    const msgs = j.messages.slice(1);
    const last = msgs[msgs.length - 1];
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    const toolNames = j.tools.map(t => t.function.name);
    log.push([j.model, sys.includes('quick side lane') ? 'side' : sys.includes('YOU ARE A BACKGROUND TASK') ? 'worker' : 'main', String(typeof lastUser.content === 'string' ? lastUser.content : '').slice(-60)]);
    // ---- side lane ----
    if (sys.includes('quick side lane')) {
      assert(!toolNames.includes('run_command') && toolNames.includes('tell_main') && toolNames.includes('start_task'), 'side tools');
      const q = msgs[0].content;
      if (/how's it going/.test(q)) {
        if (last.role === 'user') return sse(res, [call('s1', 'task_status', {})]);
        assert(last.content.includes('main: Research slow thing'), 'status shows main: ' + last.content);
        return sse(res, [say('Still on the research, about halfway.')]);
      }
      if (/use my school email/.test(q)) {
        if (last.role === 'user') return sse(res, [call('s2', 'tell_main', { message: 'use the school email' })]);
        return sse(res, [say('Got it, passing that on.')]);
      }
      if (/also find/.test(q)) {
        if (last.role === 'user') return sse(res, [call('s3', 'start_task', { task: 'Find the cheapest flight', label: 'Cheap flight' })]);
        return sse(res, [say('Started that in the background.')]);
      }
      return sse(res, [say('ok')]);
    }
    // ---- workers ----
    if (sys.includes('YOU ARE A BACKGROUND TASK')) {
      assert(!toolNames.includes('start_task'), 'workers cannot spawn');
      const task = msgs[0].content;
      if (/forever/.test(task)) { await wait(150); return sse(res, [call('w' + Math.random(), 'memory_list', {})]); }
      if (last.role === 'user') { await wait(300); return sse(res, [call('wm', 'memory_read', { name: 'USER.md' })]); }
      await wait(300);
      const name = (task.match(/Your task:\n(.*)/) || [])[1];
      return sse(res, [say(`Result for ${name}`)]);
    }
    // ---- main ----
    const userText = typeof lastUser.content === 'string' ? lastUser.content : '';
    if (msgs.some(m => m.role === 'user' && /Side note: while you worked/.test(m.content))) mainSawSide = true;
    if (msgs.some(m => m.role === 'user' && /mid-task: use the school email/.test(m.content))) mainSawCorrection = true;
    const firstUser = [...msgs].reverse().find(m => m.role === 'user' && !/^\(/.test(m.content));
    const since = msgs.slice(msgs.lastIndexOf(firstUser));
    if (/Research slow thing/.test(firstUser.content)) {
      const steps = since.filter(m => m.role === 'tool').length;
      if (steps < 6) { await wait(250); return sse(res, [call('m' + steps, 'memory_list', {})]); }
      return sse(res, [say('Research done.')]);
    }
    if (/Compare A and B/.test(firstUser.content)) {
      const tools = since.filter(m => m.role === 'tool');
      if (!tools.length) return sse(res, [calls([['a', 'start_task', { task: 'look at A', label: 'A' }], ['b', 'start_task', { task: 'look at B', label: 'B' }]])]);
      if (tools.length === 2) { const ids = tools.map(t => t.content.match(/task (t\d+)/)[1]); return sse(res, [call('wt', 'wait_tasks', { ids })]); }
      const res3 = tools[2].content;
      assert(res3.includes('Result for look at A') && res3.includes('Result for look at B'), res3);
      return sse(res, [say('A and B compared.')]);
    }
    return sse(res, [say('hi')]);
  });
});

// ---- Google + Netlify mocks ----
const gapi = http.createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
    const J = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = req.url;
    if (u === '/token') { assert(body.includes('grant_type=refresh_token') && body.includes('refresh_token=R1')); return J({ access_token: 'AT', expires_in: 3600 }); }
    assert.equal(req.headers.authorization, u.startsWith('/api/v1') ? 'Bearer nfp' : 'Bearer AT');
    if (u.startsWith('/gmail/v1/users/me/messages?')) return J({ messages: [{ id: 'm1' }, { id: 'm2' }] });
    if (u.startsWith('/gmail/v1/users/me/messages/m1?format=metadata')) return J({ id: 'm1', threadId: 'th1', snippet: 'JEE admit card', labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'NTA <nta@x.in>' }, { name: 'Subject', value: 'Admit card' }, { name: 'Date', value: 'Mon' }, { name: 'Message-ID', value: '<abc@x>' }] } });
    if (u.startsWith('/gmail/v1/users/me/messages/m2?')) return J({ id: 'm2', snippet: 'hi', payload: { headers: [{ name: 'From', value: 'Rahul' }, { name: 'Subject', value: 'Hey' }] } });
    if (u.startsWith('/gmail/v1/users/me/messages/m1?format=full')) return J({ id: 'm1', threadId: 'th1', payload: { headers: [{ name: 'From', value: 'NTA' }, { name: 'Subject', value: 'Admit card' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Download your admit card.').toString('base64url') } }] } });
    if (u === '/gmail/v1/users/me/messages/send') { const j = JSON.parse(body); const raw = Buffer.from(j.raw, 'base64url').toString(); assert(raw.includes('To: sir@school.in') && raw.includes('In-Reply-To: <abc@x>') && j.threadId === 'th1', raw); return J({ id: 'sent1' }); }
    if (u.startsWith('/calendar/v3/calendars/primary/events?') && req.method === 'GET') return J({ items: [{ id: 'e1', summary: 'Physics class', start: { dateTime: '2026-11-02T17:00:00+05:30' }, end: { dateTime: '2026-11-02T18:00:00+05:30' } }] });
    if (u.startsWith('/calendar/v3/calendars/primary/events') && req.method === 'POST') { const j = JSON.parse(body); assert.equal(j.summary, 'Study'); assert.equal(j.start.dateTime, '2026-11-03T18:00:00'); assert.equal(j.end.dateTime, '2026-11-03T19:00:00'); return J({ id: 'e2', htmlLink: 'https://cal/e2' }); }
    // Netlify
    if (u === '/api/v1/sites' && req.method === 'POST') return J({ id: 'site1', ssl_url: 'https://loop.netlify.app' });
    if (u === '/api/v1/sites/site1') return J({ id: 'site1', ssl_url: 'https://loop.netlify.app' });
    if (u === '/api/v1/sites/site1/deploys') { const j = JSON.parse(body); assert(j.files['/index.html'] && j.files['/css/a.css']); return J({ id: 'd1', required: [j.files['/index.html']] }); }
    if (u === '/api/v1/deploys/d1/files/index.html' && req.method === 'PUT') { assert.equal(body, '<h1>hi</h1>'); log.push(['netlify-upload']); return J({}); }
    if (u === '/api/v1/deploys/d1') return J({ id: 'd1', state: 'ready', ssl_url: 'https://loop.netlify.app' });
    J({ error: 'nope ' + u }, 404);
  });
});

(async () => {
  await new Promise(r => llm.listen(0, r)); await new Promise(r => gapi.listen(0, r));
  const G = `http://127.0.0.1:${gapi.address().port}`;
  process.env.ORBIT_GOOGLE_TOKEN_URL = G + '/token'; process.env.ORBIT_GOOGLE_API = G; process.env.ORBIT_GMAIL_API = G; process.env.ORBIT_NETLIFY_API = G + '/api/v1';
  const { Store } = require('../src/store');
  const { Agent } = require('../src/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit5-'));
  const store = new Store(dir, null);
  store.saveSettings({ baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, model: 'big', fastModel: 'fast', apiKey: 'sk', maxWorkers: 2, approvalMode: 'never', imageModel: 'img-1', googleClientId: 'cid', googleClientSecret: 'sec', googleRefresh: 'R1', googleEmail: 'affan@x.com', netlifyToken: 'nfp' });
  const events = [];
  const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });

  // 1) Side lane answers while main is busy, and passes a correction in.
  agent.handleUser('Research slow thing', []);
  await until(() => agent.mainBusy && agent.current && agent.current.steps.length >= 1);
  const t0 = Date.now();
  agent.handleUser("how's it going?", []);
  await until(() => events.some(e => e.type === 'assistant_end' && e.side && /halfway/.test(e.text)));
  const sideMs = Date.now() - t0;
  assert(agent.mainBusy, 'main still running while side answered');
  agent.handleUser('use my school email instead', []);
  await until(() => events.some(e => e.type === 'assistant_end' && e.side && /passing that on/.test(e.text)));
  agent.handleUser('also find a cheap flight', []);
  await until(() => events.some(e => e.type === 'assistant_end' && e.side && /background/.test(e.text)));
  await until(() => events.some(e => e.type === 'assistant_end' && e.lane === 'main' && e.text === 'Research done.'));
  await until(() => events.some(e => e.type === 'worker' && e.label === 'Cheap flight' && e.state === 'done'));
  assert(mainSawSide, 'main saw the side Q&A note'); assert(mainSawCorrection, 'main saw the correction');
  assert(log.filter(l => l[1] === 'side').every(l => l[0] === 'fast'), 'side lane uses the fast model');
  const th = store.getThread();
  assert(th.some(m => m.ui && m.side && /halfway/.test(m.content)), 'side answer saved');
  assert(th.some(m => m.ui && m.worker === 'Cheap flight'), 'worker result saved');
  // tool calls stay paired in the saved thread
  th.forEach((m, i) => { if (m.tool_calls) m.tool_calls.forEach((c, k) => assert.equal(th[i + 1 + k].tool_call_id, c.id, 'paired at ' + i)); });
  console.log(`side lane: answered in ${sideMs}ms while main ran, correction + new task passed, thread paired OK`);

  // 2) Main fans out two background tasks in parallel and waits for both.
  await until(() => !agent.mainBusy);
  const t1 = Date.now();
  agent.handleUser('Compare A and B', []);
  await until(() => events.some(e => e.type === 'assistant_end' && e.lane === 'main' && e.text === 'A and B compared.'), 10000);
  const fan = Date.now() - t1;
  assert(fan < 1150, 'two 600ms tasks ran in parallel, took ' + fan);
  assert(events.filter(e => e.type === 'tool_start' && e.lane && e.lane.startsWith('t')).length >= 2, 'worker steps emitted on their lanes');
  console.log(`fan-out: 2 background tasks in parallel, ${fan}ms OK`);

  // 3) Queue beyond maxWorkers, and stop.
  const a = agent.startWorker({ task: 'loop forever 1', label: 'F1' });
  const b = agent.startWorker({ task: 'loop forever 2', label: 'F2' });
  const c = agent.startWorker({ task: 'look at C', label: 'C' });
  assert(c.queued, 'third task queued at maxWorkers=2');
  await wait(400);
  assert(/t\d+: "F1" running/.test(agent.statusText()) && /"C" queued/.test(agent.statusText()), agent.statusText());
  agent.stopLane(a.id);
  assert(/Stopped/.test(await a.promise));
  assert.equal(await c.promise, 'Result for look at C');
  agent.stopLane(b.id); await b.promise;
  console.log('queue + stop OK');

  // 4) Voice asks run as background tasks (several at once).
  const v1 = agent.ask('look at V1', 'voice', 'check V1'); const v2 = agent.ask('look at V2', 'voice', 'check V2');
  const [r1, r2] = await Promise.all([v1, v2]);
  assert(r1.includes('V1') && r2.includes('V2'));
  console.log('voice tasks in parallel OK');

  // 5) Google
  const T = agent.tools;
  const s1 = await T.gmail_search({ query: 'is:unread' });
  assert(s1.includes('id m1') && s1.includes('NTA') && s1.includes('UNREAD'), s1);
  assert((await T.gmail_read({ id: 'm1' })).includes('Download your admit card.'));
  assert((await T.gmail_send({ to: 'sir@school.in', subject: 'Admit card', body: 'Thanks', reply_to_id: 'm1' })).includes('Sent'));
  assert((await T.calendar_events({ days: 3 })).includes('Physics class'));
  assert((await T.calendar_create({ summary: 'Study', start: '2026-11-03T18:00' })).includes('e2'));
  assert(agent._systemPrompt('main').includes('connected as affan@x.com'));
  console.log('google: gmail search/read/reply, calendar list/create OK');

  // 6) Publish + image
  const site = path.join(store.workDir, 'loop'); fs.mkdirSync(path.join(site, 'css'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>hi</h1>'); fs.writeFileSync(path.join(site, 'css', 'a.css'), 'h1{}');
  const pub = await T.publish_site({ folder: 'loop', name: 'Loop' });
  assert(pub.includes('https://loop.netlify.app') && log.some(l => l[0] === 'netlify-upload'), pub);
  const oldHome = os.homedir; os.homedir = () => dir;
  const img = await T.generate_image({ prompt: 'a terracotta orbit logo' });
  os.homedir = oldHome;
  assert(img.image.startsWith('data:image/png;base64,') && log.some(l => l[0] === 'image' && l[1] === 'img-1'));
  console.log('publish_site + generate_image OK');
  console.log('PASS');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
