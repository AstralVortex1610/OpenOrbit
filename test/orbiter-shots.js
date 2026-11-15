// Renders Orbiter with a seeded session and saves screenshots to test/out/orbiter-*.png.
const { app, BrowserWindow } = require('electron'); const fs = require('fs'); const os = require('os'); const path = require('path');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'orbshot-')); app.setPath('userData', ud);
const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });
const proj = path.join(ud, 'ride-compare'); fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
const before = `import { fetchUber } from './uber.js';\nimport { fetchOla } from './ola.js';\n\nexport async function compare(from, to) {\n  const uber = await fetchUber(from, to);\n  const ola = await fetchOla(from, to);\n  return [uber, ola].sort((a, b) => a.price - b.price);\n}\n`;
const after = `import { fetchUber } from './uber.js';\nimport { fetchOla } from './ola.js';\nimport { fetchRapido } from './rapido.js';\n\nexport async function compare(from, to) {\n  const results = await Promise.allSettled([fetchUber(from, to), fetchOla(from, to), fetchRapido(from, to)]);\n  return results\n    .filter(r => r.status === 'fulfilled' && r.value)\n    .map(r => r.value)\n    .sort((a, b) => a.price - b.price);\n}\n`;
fs.writeFileSync(path.join(proj, 'src', 'compare.js'), after);
// seed settings + one session
fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ model: 'deepseek-v4.1-flash', baseUrl: 'https://api.coarena.ai/v1', closeToTray: false, autoCall: false, autoUpdate: false, orbiterTheme: process.env.THEME || 'orbit-dark', modelTiers: { spark: { model: 'deepseek-v4.1-flash', baseUrl: '' }, pulse: { model: 'gemini-4-hydrogen', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }, surge: { model: 'kimi-k3.1-pro', baseUrl: '' } } }));
const od = path.join(ud, 'orbiter'); const sid = 'demo1'; fs.mkdirSync(path.join(od, sid), { recursive: true });
const t0 = Date.now() - 600000;
fs.writeFileSync(path.join(od, 'sessions.json'), JSON.stringify([
  { id: sid, name: 'RideCompare', folder: proj, tier: 'pulse', mode: 'acceptEdits', created: t0, updated: Date.now(), tokens: 48200, last: '', todos: [{ content: 'Read compare.js and the provider modules', status: 'completed' }, { content: 'Add Rapido provider', status: 'completed' }, { content: 'Make compare() survive a provider failing', status: 'completed' }, { content: 'Run the tests', status: 'in_progress' }, { content: 'Update README with Rapido', status: 'pending' }] },
  { id: 'demo2', name: 'Orbit site', folder: path.join(ud, 'site'), tier: 'spark', mode: 'auto', created: t0 - 9e6, updated: t0 - 9e6, todos: [], last: 'Fixed the hero animation jank.' },
  { id: 'demo3', name: 'JEE planner', folder: path.join(ud, 'jee'), tier: 'surge', mode: 'plan', created: t0 - 9e7, updated: t0 - 9e7, todos: [], last: 'Plan ready for the revision scheduler.' },
]));
const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const thread = [
  { role: 'user', content: 'Add Rapido as a third provider and make compare() not crash when one provider is down.', ui: true, at: t0, checkpoint: 'c1' },
  { role: 'assistant', content: "I'll look at how the providers are wired first.", ui: true, at: t0 + 1000, tool_calls: [tc('a1', 'todo_write', { todos: [] }), tc('a2', 'glob', { pattern: 'src/**/*.js' }), tc('a3', 'read_file', { path: 'src/compare.js' })] },
  { role: 'tool', tool_call_id: 'a1', name: 'todo_write', content: 'Todo list updated (0/5 done).', at: t0 + 2000 },
  { role: 'tool', tool_call_id: 'a2', name: 'glob', content: 'src/compare.js\nsrc/uber.js\nsrc/ola.js\ntest/compare.test.js', at: t0 + 2000 },
  { role: 'tool', tool_call_id: 'a3', name: 'read_file', content: 'src/compare.js (9 lines)\n' + before, at: t0 + 2000 },
  { role: 'assistant', content: '', ui: true, at: t0 + 3000, tool_calls: [tc('a4', 'read_file', { path: 'src/ola.js' }), tc('a5', 'write_file', { path: 'src/rapido.js', content: '' }), tc('a6', 'edit_file', { path: 'src/compare.js', old_string: '', new_string: '' })] },
  { role: 'tool', tool_call_id: 'a4', name: 'read_file', content: 'src/ola.js (22 lines)…', at: t0 + 4000 },
  { role: 'tool', tool_call_id: 'a5', name: 'write_file', content: 'Created src/rapido.js (24 lines, +24).', at: t0 + 5000 },
  { role: 'tool', tool_call_id: 'a6', name: 'edit_file', content: 'Updated src/compare.js (12 lines, +3).', at: t0 + 6000 },
  { role: 'assistant', content: "Rapido is in, and `compare()` now uses `Promise.allSettled`, so a provider that times out is skipped instead of failing the whole comparison. Running the tests next.", ui: true, at: t0 + 7000, tool_calls: [tc('a7', 'bash', { command: 'npm test', description: 'npm test' })] },
];
fs.writeFileSync(path.join(od, sid, 'thread.json'), JSON.stringify(thread));
fs.writeFileSync(path.join(od, sid, 'diffs.json'), JSON.stringify([
  { path: path.join(proj, 'src', 'rapido.js'), rel: 'src/rapido.js', before: null, after: "// Rapido fares via their public estimate endpoint.\nexport async function fetchRapido(from, to) {\n  const r = await fetch(`${BASE}/estimate?from=${from}&to=${to}`);\n  if (!r.ok) throw new Error('Rapido ' + r.status);\n  const j = await r.json();\n  return { provider: 'Rapido', price: j.fare, eta: j.eta };\n}\n", at: t0 + 5000 },
  { path: path.join(proj, 'src', 'compare.js'), rel: 'src/compare.js', before, after, at: t0 + 6000 },
]));
fs.writeFileSync(path.join(od, sid, 'checkpoints.json'), JSON.stringify([{ id: 'c1', at: t0, prompt: 'Add Rapido as a third provider and make compare() not crash when one provider is down.', threadLen: 0, files: [{ path: path.join(proj, 'src', 'compare.js'), before }] }]));

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const shot = async (w, name) => { const img = await w.webContents.capturePage(); fs.writeFileSync(path.join(out, name), img.toPNG()); console.log('saved', name); };
require('../src/main.js');
app.whenReady().then(async () => {
  await wait(2500);
  const main = BrowserWindow.getAllWindows()[0];
  main.setSize(1320, 840);
  await main.webContents.executeJavaScript('window.orbit.openOrbiter()');
  await wait(2500);
  const orb = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Orbiter');
  await orb.webContents.executeJavaScript('new Promise(r => { const t = setInterval(() => { if (window.__orbiterReady) { clearInterval(t); r(); } }, 100); })');
  // a live command approval, as Orbiter would raise it
  orb.webContents.send('orbiter:event', { type: 'approval', session: sid, id: 'ap1', title: 'Run: npm test', detail: 'npm test -- --run compare', lane: 'orb-' + sid });
  await wait(600); await shot(orb, 'orbiter-1-session.png');
  await orb.webContents.executeJavaScript(`(() => { const i = document.getElementById('input'); i.value = '/'; i.dispatchEvent(new Event('input')); })()`);
  await wait(400); await shot(orb, 'orbiter-2-slash.png');
  await orb.webContents.executeJavaScript(`(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input')); document.getElementById('themeBtn').click(); })()`);
  await wait(500); await shot(orb, 'orbiter-3-themes.png');
  await orb.webContents.executeJavaScript(`(() => { document.querySelector('.th[data-id="orbit-light"]').click(); })()`);
  await wait(500); await orb.webContents.executeJavaScript(`document.querySelector('#tabs [data-t="checkpoints"]').click()`); await wait(300); await shot(orb, 'orbiter-4-light.png');
  await orb.webContents.executeJavaScript(`document.querySelector('.th') ; document.getElementById('modeChip').click()`); await wait(400); await shot(orb, 'orbiter-5-modes.png');
  // Orbit settings: the Orbit models card
  await main.webContents.executeJavaScript(`document.querySelector('[data-view="settings"]').click()`); await wait(1200);
  await main.webContents.executeJavaScript(`document.querySelector('.tiers').scrollIntoView({ block: 'center' })`); await wait(400); await shot(main, 'orbiter-6-models.png');
  app.exit(0);
});
