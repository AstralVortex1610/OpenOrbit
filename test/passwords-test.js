// v0.11: Passwords. Save a login from chat, scrub it from the thread, sign in on a real page
// without the password ever reaching the model.
const http = require('http'); const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os'); const assert = require('assert');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };
const sse = (res, chunks) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
const call = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
const say = (t) => ({ choices: [{ delta: { content: t } }] });
const PASS = 'Hunter2!x9';
let site, gotLogin = null; const seenByModel = [];
// a two-step sign-in page: username first, then password (like Google)
const web = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (req.url === '/login') return res.end(`<title>Sign in</title><form method="post" action="/step2"><label>Email <input type="email" name="email"></label><button>Next</button></form>`);
  if (req.url === '/step2') { const u = new URLSearchParams(b).get('email'); return res.end(`<title>Password</title><form method="post" action="/done"><input type="hidden" name="email" value="${u}"><input type="password" name="pw"><button>Sign in</button></form>`); }
  if (req.url === '/done') { gotLogin = Object.fromEntries(new URLSearchParams(b)); return res.end(`<title>Welcome</title><h1>Welcome ${gotLogin.email}</h1>`); }
  res.end('hi');
}); });
const llm = http.createServer((req, res) => { let body = ''; req.on('data', d => (body += d)); req.on('end', async () => {
  const j = JSON.parse(body); seenByModel.push(body); const msgs = j.messages.slice(1); const last = msgs[msgs.length - 1];
  const u = [...msgs].reverse().find(m => m.role === 'user' && !/^\(/.test(m.content)).content;
  const tools = msgs.slice(msgs.lastIndexOf([...msgs].reverse().find(m => m.content === u))).filter(m => m.role === 'tool');
  if (/save my test login/.test(u)) { if (!tools.length) return sse(res, [call('p1', 'password_save', { site, username: 'affan@x.com', password: PASS, url: site + '/login' })]); return sse(res, [say('Saved your test site login.')]); }
  if (/sign in to the test site/.test(u)) {
    if (tools.length === 0) return sse(res, [call('l1', 'password_list', { site })]);
    const id = tools[0].content.split(' · ')[0];
    if (tools.length === 1) return sse(res, [call('l2', 'browser_navigate', { url: site + '/login' })]);
    if (tools.length === 2) { assert(/Saved login for this site: id /.test(tools[1].content), 'page hints the saved login: ' + tools[1].content.slice(0, 300)); return sse(res, [call('l3', 'browser_login', { id })]); }
    if (tools.length === 3) { assert(/next step/.test(tools[2].content), 'step 1 username'); return sse(res, [call('l4', 'browser_login', { id })]); }
    assert(/Welcome affan@x.com/.test(tools[3].content), 'signed in: ' + tools[3].content.slice(0, 200));
    return sse(res, [say('Signed in.')]);
  }
  sse(res, [say('hi')]);
}); });
(async () => {
  await new Promise(r => web.listen(0, r)); await new Promise(r => llm.listen(0, r));
  site = `http://127.0.0.1:${web.address().port}`;
  const { Store } = require('../src/store'); const { Agent } = require('../src/agent');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pw-'));
  const store = new Store(dir, null);
  store.saveSettings({ baseUrl: `http://127.0.0.1:${llm.address().port}/v1`, model: 'big', apiKey: 'sk', approvalMode: 'never' });
  const events = []; const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });
  const done = (re) => new Promise((res, rej) => { const t = Date.now(); const iv = setInterval(() => { const e = events.find(e => e.type === 'assistant_end' && e.lane === 'main' && re.test(e.text)); if (e) { clearInterval(iv); res(); } else if (Date.now() - t > 30000) { clearInterval(iv); rej(new Error('timeout ' + re + ' ' + JSON.stringify(events.filter(e => e.type === 'error')))); } }, 30); });
  agent.handleUser(`save my test login: affan@x.com / ${PASS}`, []); await done(/Saved/);
  const l = agent.passwords.list(); assert(l.length === 1 && l[0].username === 'affan@x.com' && l[0].hasPassword && !('passEnc' in l[0]), 'saved, list hides password');
  assert(!JSON.stringify(store.getThread()).includes(PASS), 'password scrubbed from the saved chat');
  assert(fs.readFileSync(path.join(dir, 'logins.json'), 'utf8').indexOf(PASS) === -1, 'not stored in plain text in the vault file... (base64 without safeStorage)');
  console.log('ok  login saved from chat and scrubbed from history');
  const before = seenByModel.length;
  agent.handleUser('sign in to the test site', []); await done(/Signed in/);
  assert.deepEqual(gotLogin, { email: 'affan@x.com', pw: PASS }, 'site got the right login');
  assert(!seenByModel.slice(before).some(b => b.includes(PASS)), 'model never saw the password while signing in');
  console.log('ok  two-step sign-in with the saved login; model never saw the password');
  await agent.browser.close().catch(() => {});
  console.log('PASS passwords-test'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
