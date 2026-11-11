// Backup models: main model hits a 429, Orbit switches to backup 1 (other provider, own key) and carries on.
const http = require('http'); const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return { shell: { openExternal: async () => {}, openPath: async () => '' } }; return origLoad.call(this, req, ...rest); };
const { Store } = require('../src/store'); const { Agent } = require('../src/agent'); const { newer } = require('../src/updater');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
const seen = [];
const mk = (name) => http.createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
  const j = JSON.parse(b); seen.push(`${name}:${j.model}:${req.headers.authorization}`);
  if (j.model === 'main-model') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests' } })); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi from ' + j.model } }] }) + '\n\ndata: [DONE]\n\n'); res.end(); }); });
const A = mk('A'), B = mk('B');
A.listen(0, () => B.listen(0, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fb-')); const store = new Store(dir, null);
  store.saveSettings({ baseUrl: `http://127.0.0.1:${A.address().port}/v1`, model: 'main-model', apiKey: 'sk-main', backupModels: [{ model: 'backup-b', baseUrl: `http://127.0.0.1:${B.address().port}/v1`, apiKey: 'sk-b' }, { model: 'backup-same' }] });
  const ui = store.getSettingsForUI();
  assert(ui.backupModels.length === 2 && ui.backupModels[0].hasKey && !('apiKey' in ui.backupModels[0]) && !('apiKeyEnc' in ui.backupModels[0]), 'backup keys stored encrypted, hidden from UI');
  // re-save from UI without retyping the key keeps it
  store.saveSettings({ backupModels: ui.backupModels.map(b => ({ id: b.id, model: b.model, baseUrl: b.baseUrl, apiKey: '' })) });
  assert(store.getSettings().backupModels[0].apiKey === 'sk-b', 'key kept on re-save');
  // saving other settings (like a new ntfy topic) leaves brain + backups alone
  store.saveSettings({ ntfyTopic: 'orbit-new' });
  const s2 = store.getSettings(); assert(s2.model === 'main-model' && s2.apiKey === 'sk-main' && s2.backupModels.length === 2, 'partial save keeps brain settings');
  const events = []; const agent = new Agent({ store, emit: (e) => events.push(e), reachOut: () => {} });
  agent.handleUser('hello', []);
  await new Promise(r => { const t = setInterval(() => { if (events.some(e => e.type === 'busy' && !e.busy)) { clearInterval(t); r(); } }, 50); });
  const end = events.find(e => e.type === 'assistant_end' && !e.interim);
  assert(end && /hi from backup-b/.test(end.text), 'answered by backup-b: ' + (end && end.text));
  assert(seen[0] === 'A:main-model:Bearer sk-main' && seen[1] === 'B:backup-b:Bearer sk-b', 'chain order + per-backup key: ' + seen.join(' | '));
  assert(events.some(e => e.type === 'model_switch' && e.model === 'backup-b'), 'UI told about the switch');
  seen.length = 0; agent.handleUser('again', []);
  await new Promise(r => setTimeout(r, 600));
  assert(seen[0] && seen[0].startsWith('B:backup-b'), 'limited model sits out (cooldown): ' + seen.join(' | '));
  assert(newer('0.9.0-beta', '0.8.1') && !newer('0.8.1-beta', '0.8.1') && newer('v0.10.0', '0.9.9'), 'version compare');
  console.log('PASS fallback-test'); process.exit(0);
}));
