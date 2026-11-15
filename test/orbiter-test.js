// Orbiter engine: tools, permission modes, checkpoints/rewind, tiers, status. No network.
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { Store } = require('../src/store'); const { Orbiter, globToRe, RISKY } = require('../src/orbiter');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-')); const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
fs.mkdirSync(path.join(proj, 'src')); fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'const x = 1;\nconsole.log(x);\n'); fs.writeFileSync(path.join(proj, 'README.md'), '# hi\n');
fs.mkdirSync(path.join(proj, 'node_modules', 'z'), { recursive: true }); fs.writeFileSync(path.join(proj, 'node_modules', 'z', 'i.js'), 'const x = 1;');
const store = new Store(dir, null); store.saveSettings({ model: 'main-m', baseUrl: 'https://main/v1', apiKey: 'k', modelTiers: { surge: { model: 'big', baseUrl: 'https://other/v1', apiKey: 'k2' } } });
const approvals = []; let approve = true;
const { Agent } = require('../src/agent');
const agent = { store, ctls: new Map(), requestApproval: async (lane, t, d) => { approvals.push(t); return approve; }, askUser: async () => 'yes', tools: { web_search: async () => 'r', fetch_url: async () => 'f' } };
agent.tierSettings = Agent.prototype.tierSettings.bind(agent);
const events = []; const o = new Orbiter({ agent, store, emit: (e) => events.push(e) });
(async () => {
  assert(globToRe('src/**/*.js').test('src/a.js')); assert(globToRe('**/*.{js,ts}').test('x/y/z.ts')); assert(RISKY.test('git push --force')); assert(!RISKY.test('npm test'));
  const s = o.createSession({ folder: proj, mode: 'ask' });
  // checkpoint as send() would make
  o._saveCheckpoints(s.id, [{ id: 'cp1', at: Date.now(), prompt: 'p', threadLen: 0, files: [] }]);
  const T = o._tools(s, 'orb-' + s.id);
  assert((await T.glob({ pattern: '**/*.js' })).includes('src/a.js')); assert(!(await T.glob({ pattern: '**/*.js' })).includes('node_modules'));
  assert((await T.grep({ pattern: 'const x' })).includes('src/a.js:1:'));
  await assert.rejects(T.edit_file({ path: 'src/a.js', old_string: 'x = 1', new_string: 'x = 2' }), /Read/);
  assert((await T.read_file({ path: 'src/a.js' })).includes('    1  const x = 1;'));
  await T.edit_file({ path: 'src/a.js', old_string: 'x = 1', new_string: 'x = 2' });
  assert.strictEqual(approvals.length, 1, 'ask mode asks before an edit');
  assert(fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8').includes('x = 2'));
  assert(events.some(e => e.type === 'orbiter_diff' && e.rel.includes('a.js')));
  await assert.rejects(T.edit_file({ path: 'src/a.js', old_string: 'nope', new_string: 'y' }), /not found/);
  o.updateSession(s.id, { mode: 'acceptEdits' });
  await T.write_file({ path: 'src/new.js', content: 'new\n' }); assert.strictEqual(approvals.length, 1, 'accept edits does not ask for edits');
  approve = false; await assert.rejects(T.bash({ command: 'echo hi' }), /said no/); approve = true;
  o.updateSession(s.id, { mode: 'auto' });
  const out = await T.bash({ command: 'echo orbiter-ok' }); assert(out.includes('orbiter-ok') && out.startsWith('exit 0'));
  const n = approvals.length; await T.bash({ command: 'git reset --hard' }).catch(() => {}); assert.strictEqual(approvals.length, n + 1, 'auto asks before risky commands');
  o.updateSession(s.id, { mode: 'plan' }); await assert.rejects(T.write_file({ path: 'x.txt', content: '1' }), /Plan mode/);
  await T.todo_write({ todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }] });
  assert(o.statusText().includes('todos 1/2'));
  // rewind restores the edit and removes the created file
  const r = o.rewind(s.id, 'cp1'); assert.strictEqual(r.restored, 2);
  assert(fs.readFileSync(path.join(proj, 'src', 'a.js'), 'utf8').includes('x = 1')); assert(!fs.existsSync(path.join(proj, 'src', 'new.js')));
  // tiers: surge goes to its own provider with the main model behind it; unmapped tiers use the main model
  const ts = agent.tierSettings('surge'); assert.strictEqual(ts.model, 'big'); assert.strictEqual(ts.settings.baseUrl, 'https://other/v1'); assert.strictEqual(ts.settings.backupModels[0].model, 'main-m');
  assert.strictEqual(agent.tierSettings('spark').model, 'main-m');
  // memory + themes
  fs.writeFileSync(path.join(proj, 'ORBITER.md'), 'Use tabs.'); assert(o._system(o.session(s.id)).includes('Use tabs.'));
  const tid = o.saveTheme('Sea Glass', { base: 'orbit-dark', overrides: { accent: '#5fb3a8' } }); assert.strictEqual(tid, 'custom:sea-glass'); assert(o.themes()[0].overrides.accent);
  console.log('orbiter-test: all passed');
})().catch(e => { console.error(e); process.exit(1); });
