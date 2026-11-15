// v0.12.1: a model picked mid-task takes over at once; Spark/Pulse/Surge ride the Brain's provider;
// network errors say what failed; updates download and install on their own.
const http = require('http'); const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };
const { Store } = require('../src/store'); const { Agent } = require('../src/agent'); const { applyScript, Updater } = require('../src/updater');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
const seen = [];
const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
  const j = JSON.parse(b); seen.push(`${j.model}:${req.headers.authorization}`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (j.model === 'slow-a') { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'thinking with a…' } }] }) + '\n\n'); const t = setTimeout(() => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' done by slow-a' } }] }) + '\n\ndata: [DONE]\n\n'); res.end(); }, 4000); req.on('close', () => clearTimeout(t)); return; }
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi from ' + j.model } }] }) + '\n\ndata: [DONE]\n\n'); res.end(); }); });
const wait = (fn, ms = 8000) => new Promise((r, x) => { const t0 = Date.now(); const t = setInterval(() => { if (fn()) { clearInterval(t); r(); } else if (Date.now() - t0 > ms) { clearInterval(t); x(new Error('timeout')); } }, 30); });
srv.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-121-')); const store = new Store(dir, null);
  // an old tier that pointed somewhere else with its own key
  store.saveSettings({ baseUrl: base, model: 'slow-a', apiKey: 'sk-main', modelTiers: { spark: { model: 'fast-b', baseUrl: 'https://old.example/v1', apiKey: 'sk-old' }, pulse: { model: 'mid-c' } } });
  assert(store.getSettings().modelTiers.spark.apiKey === 'sk-old', 'legacy tier key kept while it has its own base URL');
  // Settings now saves tiers as models on the Brain's provider
  store.saveSettings({ modelTiers: { spark: { model: 'fast-b', baseUrl: '', clearKey: true }, pulse: { model: 'mid-c', baseUrl: '', clearKey: true }, surge: { model: '', baseUrl: '' } } });
  const events = []; const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });
  const sp = agent.tierSettings('spark');
  assert(sp.model === 'fast-b' && sp.settings.baseUrl === base && sp.settings.apiKey === 'sk-main', 'Spark uses the Brain provider and key');
  const su = agent.tierSettings('surge');
  assert(su.model === 'slow-a', 'unset Surge falls back to the main model');
  const ch = agent.modelChoices();
  assert(ch.length === 4 && ch[0].id === '' && ch[0].model === 'slow-a' && ch[1].model === 'fast-b' && ch[3].model === '', 'one choice list: Main, Spark, Pulse, Surge');

  // mid-task switch: start on slow-a, pick Spark while it is still answering
  agent.handleUser('build it', []);
  await wait(() => events.some(e => e.type === 'delta'));
  store.saveSettings({ chatTier: 'spark' });
  const n = agent.retarget('main');
  assert(n === 1, 'running main lane retargeted');
  await wait(() => events.some(e => e.type === 'busy' && !e.busy));
  const end = events.filter(e => e.type === 'assistant_end' && !e.interim).pop();
  assert(end && end.text === 'hi from fast-b', 'the task finished on the newly picked model: ' + (end && end.text));
  assert(events.some(e => e.type === 'stream_reset') && events.some(e => e.type === 'model_switch' && e.reason === 'picked' && e.model === 'fast-b'), 'UI told: partial reply dropped, now on fast-b');
  assert(seen.join(' ') === 'slow-a:Bearer sk-main fast-b:Bearer sk-main', 'calls: ' + seen.join(' | '));
  // picking the same model again does nothing
  assert(agent.retarget('main') === 0, 'no running work, nothing to retarget');
  // next message uses the picked model straight away
  seen.length = 0; events.length = 0; agent.handleUser('again', []);
  await wait(() => events.some(e => e.type === 'busy' && !e.busy));
  assert(seen[0] === 'fast-b:Bearer sk-main', 'next message on the picked model');

  // a project lane follows its own pick, live
  const s = store.getSettings();
  const pickProj = () => { const t = agent.tierSettings('pulse'); return { settings: t.settings, model: t.model }; };
  const p = pickProj(); assert(p.model === 'mid-c', 'project pick resolves');

  // network failure explains itself
  store.saveSettings({ chatTier: '', baseUrl: 'http://orbit-no-such-host.invalid/v1', backupModels: [] });
  events.length = 0; agent.handleUser('hello', []);
  await wait(() => events.some(e => e.type === 'busy' && !e.busy), 15000);
  const err = events.find(e => e.type === 'error');
  assert(err && /Couldn't reach orbit-no-such-host\.invalid for slow-a/.test(err.message) && !/^fetch failed$/i.test(err.message), 'network error names host and model: ' + (err && err.message));

  // updater: install-on-quit does not relaunch; normal install does
  const a = applyScript({ zip: 'z', tmp: 't', dest: 'd', exe: 'Orbit.exe', log: 'l', want: '0.12.1', pid: 1, flag: 'f', relaunch: false });
  const b = applyScript({ zip: 'z', tmp: 't', dest: 'd', exe: 'Orbit.exe', log: 'l', want: '0.12.1', pid: 1, flag: 'f' });
  assert(!/Start-Process -FilePath/.test(a) && /Start-Process -FilePath/.test(b), 'quit-time install skips the relaunch');
  const fakeApp = { getVersion: () => '0.12.0', getPath: () => dir, isPackaged: false };
  const u = new Updater({ app: fakeApp, send: () => {} });
  u.check = async () => u._set({ status: 'available', latest: '0.12.1', url: 'x' });
  let ready = false; u.onReady = () => (ready = true);
  u.auto = true; await u.autoStep();
  assert(u.state.status === 'available' && !ready, 'auto step finds the update (download only runs in the packaged Windows app)');
  u.startAuto(false);
  srv.close(); console.log('PASS v121-test'); process.exit(0);
});
