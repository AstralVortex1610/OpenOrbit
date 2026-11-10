// Orbit — Home, Projects and Updates.
//   Projects : their own chat thread, their own files folder and a standing brief Orbit keeps current.
//   Panels   : glanceable cards on Home. Orbit gathers real values with its tools and refreshes them on a schedule.
//   Updates  : one feed of everything Orbit did on its own (scheduled runs, background tasks, replies you missed).
const fs = require('fs');
const path = require('path');

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const slug = (s) => String(s || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'project';
const HUES = ['#c4673a', '#e4a270', '#ae4e27', '#b9835a', '#d98b5f', '#9c5b3b', '#cf9b6b', '#8f6a4f'];

class Hub {
  constructor(store) {
    this.store = store;
    this.dir = path.join(store.dir || require('os').tmpdir(), 'projects');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
  }
  _r(n, f) { return this.store._read(n, f); }
  _w(n, d) { fs.mkdirSync(path.dirname(path.join(this.store.dir, n)), { recursive: true }); this.store._write(n, d); }

  // ----- projects -----
  projects() { return this._r('projects.json', []).sort((a, b) => (b.updated || 0) - (a.updated || 0)); }
  project(id) { return this._r('projects.json', []).find(p => p.id === id) || null; }
  createProject({ name, about }) {
    name = String(name || '').trim() || 'New project';
    const list = this._r('projects.json', []);
    const p = {
      id: `${slug(name)}-${Date.now().toString(36).slice(-4)}`,
      name, about: String(about || '').trim(),
      brief: `# ${name}\n\n## Goal\n${String(about || '').trim() || '(not set yet)'}\n\n## Decisions\n\n## Open threads\n`,
      color: HUES[list.length % HUES.length], created: Date.now(), updated: Date.now(), last: '',
    };
    list.push(p); this._w('projects.json', list);
    fs.mkdirSync(this.filesDir(p.id), { recursive: true });
    return p;
  }
  updateProject(id, patch) {
    const list = this._r('projects.json', []).map(p => (p.id === id ? { ...p, ...patch } : p));
    this._w('projects.json', list);
    return list.find(p => p.id === id) || null;
  }
  deleteProject(id) {
    this._w('projects.json', this._r('projects.json', []).filter(p => p.id !== id));
    try { fs.rmSync(path.join(this.dir, id), { recursive: true, force: true }); } catch {}
  }
  filesDir(id) { return path.join(this.dir, id, 'files'); }
  thread(id) { return this._r(`projects/${id}/thread.json`, []); }
  saveThread(id, t) { this._w(`projects/${id}/thread.json`, t.slice(-400)); }
  clearThread(id) { this._w(`projects/${id}/thread.json`, []); }
  listFiles(id) {
    const root = this.filesDir(id); const out = [];
    const walk = (d, rel) => {
      if (!fs.existsSync(d) || out.length > 300) return;
      for (const f of fs.readdirSync(d)) {
        const full = path.join(d, f); const r = rel ? `${rel}/${f}` : f; const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, r); else out.push({ name: r, size: st.size, updated: st.mtimeMs, path: full });
      }
    };
    walk(root, '');
    return out.sort((a, b) => b.updated - a.updated);
  }

  // ----- panels -----
  panels() { return this._r('panels.json', []); }
  panel(id) { return this.panels().find(p => p.id === id) || null; }
  addPanel({ title, prompt, everyMinutes }) {
    const list = this.panels();
    const p = { id: 'p' + uid(), title: String(title || '').trim() || 'New panel', prompt: String(prompt || '').trim(), everyMinutes: clampEvery(everyMinutes), status: 'building', data: null, updatedAt: 0, error: '', created: Date.now() };
    list.push(p); this._w('panels.json', list);
    return p;
  }
  updatePanel(id, patch) {
    if (patch.everyMinutes !== undefined) patch.everyMinutes = clampEvery(patch.everyMinutes);
    const list = this.panels().map(p => (p.id === id ? { ...p, ...patch } : p));
    this._w('panels.json', list);
    return list.find(p => p.id === id) || null;
  }
  movePanel(id, dir) {
    const list = this.panels(); const i = list.findIndex(p => p.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]]; this._w('panels.json', list);
  }
  deletePanel(id) { this._w('panels.json', this.panels().filter(p => p.id !== id)); }

  // ----- updates -----
  updates() { return this._r('updates.json', []); }
  addUpdate(u) {
    const list = this.updates();
    const item = { id: 'u' + uid(), at: Date.now(), read: false, kind: 'notice', title: 'Orbit', text: '', ...u };
    item.text = String(item.text || '').slice(0, 4000);
    list.unshift(item); this._w('updates.json', list.slice(0, 300));
    return item;
  }
  markRead(ids) { this._w('updates.json', this.updates().map(u => (!ids || ids.includes(u.id) ? { ...u, read: true } : u))); }
  clearUpdates() { this._w('updates.json', []); }
  unread() { return this.updates().filter(u => !u.read).length; }
}

// 0 = only when asked. Otherwise at least every 30 minutes, at most once a day... or weekly.
function clampEvery(v) { const n = Number(v); if (!n || n <= 0) return n === 0 ? 0 : 180; return Math.max(30, Math.min(10080, Math.round(n))); }

// ---------------- agent side ----------------
const PANEL_TOOLS = new Set(['web_search', 'fetch_url', 'gmail_search', 'gmail_read', 'calendar_events', 'memory_read', 'memory_list', 'read_file', 'list_dir']);
const NO_PROJECT = new Set(['tell_main']);

const PANEL_SHAPE = `{
  "title": "2-4 word title",
  "kind": "stat" | "list" | "text" | "progress",
  "value": "the headline value for stat/progress, e.g. \\"₹1,24,300\\", \\"31°\\", \\"12 days\\"",
  "unit": "optional small unit next to value",
  "delta": "optional change, e.g. \\"+1.8% today\\"",
  "trend": "up" | "down" | "flat",
  "sub": "one short line of context",
  "progress": 0.0 to 1.0 (progress only),
  "items": [{ "label": "...", "value": "optional", "sub": "optional", "url": "optional link" }] (list: up to 6),
  "text": "two or three short sentences (text only)",
  "link": "optional page to open for more",
  "source": "where the values came from, e.g. \\"github.com\\""
}`;

function install(Agent) {
  const { buildTools, TOOL_SCHEMAS } = require('./tools');
  const schemasFor = (allow) => TOOL_SCHEMAS.filter(t => allow(t.function.name));

  Agent.prototype.postUpdate = function (u) {
    const item = this.hub.addUpdate(u);
    this.emit({ type: 'updates_changed', unread: this.hub.unread(), latest: item });
    return item;
  };

  // ---------------- project chats ----------------
  Agent.prototype.projectSend = function (pid, text, attachments) {
    if (!this.hub.project(pid)) return;
    this.projQ = this.projQ || new Map(); this.projBusy = this.projBusy || new Set();
    if (!this.projQ.has(pid)) this.projQ.set(pid, []);
    this.projQ.get(pid).push({ text, attachments });
    this._projDrain(pid);
  };
  Agent.prototype.projectBusy = function (pid) { return !!(this.projBusy && this.projBusy.has(pid)); };
  Agent.prototype._projDrain = async function (pid) {
    if (this.projBusy.has(pid)) return;
    const job = (this.projQ.get(pid) || []).shift();
    if (!job) return;
    const lane = 'proj-' + pid;
    const emit = (e) => this.emit({ ...e, lane, project: pid });
    this.projBusy.add(pid);
    emit({ type: 'busy', busy: true });
    try { await this._projTurn(pid, job, lane, emit); }
    catch (e) { emit({ type: 'error', message: e.name === 'AbortError' ? 'Stopped.' : e.message }); }
    finally {
      this.ctls.delete(lane); this.projBusy.delete(pid);
      emit({ type: 'busy', busy: false });
      setTimeout(() => this._projDrain(pid), 0);
    }
  };
  Agent.prototype._projTurn = async function (pid, { text, attachments }, lane, emit) {
    const s = this.store.getSettings();
    const p = this.hub.project(pid);
    if (!s.apiKey) { emit({ type: 'error', message: 'Orbit needs a brain first. Open Settings and add your base URL, API key and model.' }); return; }
    const append = (m) => { const t = this.hub.thread(pid); t.push(m); this.hub.saveThread(pid, t); };
    let content = text;
    if (attachments && attachments.length) content = [{ type: 'text', text: text || 'Look at this.' }, ...attachments.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } }))];
    const msg = { role: 'user', content, ui: true, id: uid(), at: Date.now() };
    append(msg);
    emit({ type: 'user_message', id: msg.id, text, images: (attachments || []).map(a => a.dataUrl) });
    this.hub.updateProject(pid, { updated: Date.now() });
    const laneObj = { id: lane, project: pid };
    const res = await this._loop({
      lane, emit,
      system: () => this._systemPrompt('main') + projectSection(this.hub.project(pid) || p, this.hub),
      context: () => this._contextMessages(this.hub.thread(pid), 50),
      append,
      tools: buildTools(this, laneObj),
      schemas: schemasFor(n => !NO_PROJECT.has(n)),
      model: s.model, maxSteps: Number(s.maxSteps) || 25, streamToUI: true,
    });
    if (laneObj.browser && laneObj.browser.page) laneObj.browser.close().catch(() => {});
    if (res.limit) { emit({ type: 'error', message: `I hit my step limit (${res.limit}) on this one. Say "continue" and I'll keep going.` }); return; }
    const assistant = { role: 'assistant', content: res.text, ui: true, at: Date.now(), id: res.msgId };
    append(assistant);
    emit({ type: 'assistant_end', id: res.msgId, text: res.text });
    this.hub.updateProject(pid, { updated: Date.now(), last: res.text.replace(/[#*_`>]/g, '').slice(0, 160) });
    this.emit({ type: 'projects_changed' });
    if (this.viewScope !== pid) this.postUpdate({ kind: 'project', title: p.name, text: res.text, target: { project: pid } });
  };

  // ---------------- panels ----------------
  Agent.prototype.refreshPanel = async function (id) {
    this.panelBusy = this.panelBusy || new Set();
    if (this.panelBusy.has(id)) return;
    const p = this.hub.panel(id); if (!p) return;
    const s = this.store.getSettings();
    if (!s.apiKey) { this.hub.updatePanel(id, { status: 'error', error: 'Add a model in Settings first.' }); this.emit({ type: 'panels_changed' }); return; }
    this.panelBusy.add(id);
    this.hub.updatePanel(id, { status: p.data ? 'refreshing' : 'building' });
    this.emit({ type: 'panels_changed' });
    const lane = 'panel-' + id;
    const thread = [{ role: 'user', content: `Panel on the user's Home: "${p.title}"\nWhat it should show: ${p.prompt}\n${p.data ? `Last values (replace them with fresh ones): ${JSON.stringify(p.data).slice(0, 1500)}\n` : ''}\nGather current, real values with your tools. Then reply with ONLY one JSON object (no prose, no code fence) in this shape:\n${PANEL_SHAPE}\nPick the kind that fits: one number = stat, a few items = list, a goal or countdown = progress, a short brief = text. Never invent values; if a value can't be found, say so in "sub".` }];
    try {
      const res = await this._loop({
        lane, emit: () => {},
        system: () => `You fill in a glanceable panel on ${s.userName || 'the user'}'s Home screen in Orbit. Be fast: use the fewest tool calls, several at once when they don't depend on each other. Values must be real and current. Keep every string short; a panel is read in two seconds.\nNow: ${new Date().toString()}\n\nAbout the user:\n${(this.store.readMemory('USER.md') || '').slice(0, 1500)}`,
        context: () => thread, append: (m) => thread.push(m),
        tools: buildTools(this, { id: lane }),
        schemas: schemasFor(n => PANEL_TOOLS.has(n)),
        model: s.fastModel || s.model, maxSteps: 10, streamToUI: false,
      });
      const data = parsePanel(res.text);
      if (!data) throw new Error(res.limit ? 'Ran out of steps gathering values.' : "Couldn't read the values Orbit gathered.");
      this.hub.updatePanel(id, { data, title: p.title === 'New panel' && data.title ? data.title : p.title, status: 'ok', error: '', updatedAt: Date.now() });
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Stopped.' : e.message;
      this.hub.updatePanel(id, { status: 'error', error: String(msg).slice(0, 200), updatedAt: Date.now() });
      if (!p.lastErrorPosted || Date.now() - p.lastErrorPosted > 6 * 3600e3) {
        this.hub.updatePanel(id, { lastErrorPosted: Date.now() });
        this.postUpdate({ kind: 'panel', title: `Panel "${p.title}" couldn't refresh`, text: String(msg), target: { view: 'home' } });
      }
    } finally {
      this.ctls.delete(lane); this.panelBusy.delete(id);
      this.emit({ type: 'panels_changed' });
    }
  };
  // Called every minute: refresh panels that are due, two at a time.
  Agent.prototype.panelTick = function () {
    this.panelBusy = this.panelBusy || new Set();
    if (!this.store.getSettings().apiKey) return;
    const now = Date.now();
    for (const p of this.hub.panels()) {
      if (this.panelBusy.size >= 2) break;
      if (this.panelBusy.has(p.id)) continue;
      const stuck = (p.status === 'building' || p.status === 'refreshing');
      const due = !p.updatedAt || (p.everyMinutes > 0 && now - p.updatedAt >= p.everyMinutes * 60000) || stuck;
      if (due) this.refreshPanel(p.id);
    }
  };
}

function projectSection(p, hub) {
  if (!p) return '';
  const files = hub.listFiles(p.id).slice(0, 40).map(f => `- ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join('\n') || '- (empty)';
  return `

# PROJECT: ${p.name}
You are working inside the user's project "${p.name}". This chat is only about this project.
- Project files folder: ${hub.filesDir(p.id)}
  Save everything you make for this project there (use full paths with write_file and run_command cwd).
- The brief below is this project's standing memory. When a goal, decision, file, or open thread changes, update it with project_brief (send the whole brief). Keep it short.

## Brief
${String(p.brief || '').slice(0, 5000)}

## Files
${files}`;
}

function parsePanel(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const d = JSON.parse(t.slice(a, b + 1));
    if (!d || typeof d !== 'object') return null;
    const kind = ['stat', 'list', 'text', 'progress'].includes(d.kind) ? d.kind : (Array.isArray(d.items) && d.items.length ? 'list' : d.value ? 'stat' : 'text');
    const str = (v, n = 160) => (v === undefined || v === null ? '' : String(v).slice(0, n));
    return {
      title: str(d.title, 40), kind, value: str(d.value, 24), unit: str(d.unit, 12), delta: str(d.delta, 30),
      trend: ['up', 'down', 'flat'].includes(d.trend) ? d.trend : '', sub: str(d.sub, 140),
      progress: Math.max(0, Math.min(1, Number(d.progress) || 0)),
      items: (Array.isArray(d.items) ? d.items : []).slice(0, 6).map(i => ({ label: str(i && i.label, 80), value: str(i && i.value, 24), sub: str(i && i.sub, 90), url: /^https?:\/\//.test(i && i.url) ? str(i.url, 400) : '' })),
      text: str(d.text, 420), link: /^https?:\/\//.test(d.link || '') ? str(d.link, 400) : '', source: str(d.source, 40),
    };
  } catch { return null; }
}

module.exports = { Hub, install, parsePanel };
