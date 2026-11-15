// Orbiter — Orbit's coding agent. A Claude Code-style desktop coder that works inside one folder:
// sessions, permission modes (ask / accept edits / plan / auto / bypass), checkpoints and rewind,
// a todo list, ORBITER.md project memory, slash commands and its own model tier (Spark, Pulse, Surge).
// It shares Orbit's agent loop, model chain, usage and approvals, so chat can see and steer it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const TIERS = [
  { id: 'spark', name: 'Spark', blurb: 'Fast and cheap. Quick edits, questions, small fixes.' },
  { id: 'pulse', name: 'Pulse', blurb: 'Balanced. Everyday coding.' },
  { id: 'surge', name: 'Surge', blurb: 'Strongest. Hard bugs, big refactors, planning.' },
];
const MODES = [
  { id: 'ask', name: 'Ask first', blurb: 'Asks before every edit and command.' },
  { id: 'acceptEdits', name: 'Accept edits', blurb: 'Edits files on its own, asks before commands.' },
  { id: 'plan', name: 'Plan', blurb: 'Reads and plans only. Nothing changes until you approve the plan.' },
  { id: 'auto', name: 'Auto', blurb: 'Does the work, asks only before risky commands.' },
  { id: 'bypass', name: 'Bypass', blurb: 'Never asks. Use in a throwaway folder.' },
];
const READ_ONLY = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'exit_plan_mode', 'ask_user']);
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit']);
const RISKY = /\b(rm\s+-rf|rmdir\s+\/s|Remove-Item\b[^|]*-Recurse|format\s+[a-z]:|del\s+\/[sq]|git\s+push\s+(-f|--force)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|shutdown|Stop-Computer|mkfs|dd\s+if=|curl[^|]*\|\s*(sh|bash)|iwr[^|]*\|\s*iex|npm\s+publish|reg\s+delete)\b/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', '.cache', 'coverage']);

const SCHEMAS = [
  fn('read_file', 'Read a file in the project. Returns numbered lines. Use offset/limit for big files.', { path: { type: 'string' }, offset: { type: 'number', description: 'First line (1-based).' }, limit: { type: 'number', description: 'How many lines (default 2000).' } }, ['path']),
  fn('list_dir', 'List a folder (relative to the project root).', { path: { type: 'string' } }, ['path']),
  fn('glob', 'Find files by glob pattern, e.g. "src/**/*.js". Newest first.', { pattern: { type: 'string' } }, ['pattern']),
  fn('grep', 'Search file contents with a regular expression. Returns file:line: text.', { pattern: { type: 'string' }, path: { type: 'string', description: 'Folder or file to search (default the project root).' }, glob: { type: 'string', description: 'Only files matching this, e.g. "*.ts".' }, ignore_case: { type: 'boolean' } }, ['pattern']),
  fn('write_file', 'Create or overwrite a file. Read a file before overwriting it.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('edit_file', 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first.', { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']),
  fn('multi_edit', 'Several exact-string edits to one file, applied in order, all or nothing.', { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } } }, ['path', 'edits']),
  fn('bash', 'Run a shell command in the project folder (PowerShell on Windows, bash elsewhere). Use for tests, builds, git, installs.', { command: { type: 'string' }, timeout_sec: { type: 'number', description: 'Default 120, max 600.' }, description: { type: 'string', description: 'Five words on what it does.' } }, ['command']),
  fn('todo_write', 'Replace the task list shown to the user. Use it for any job with 3+ steps; keep exactly one item in_progress.', { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } }, ['todos']),
  fn('web_search', 'Search the web.', { query: { type: 'string' } }, ['query']),
  fn('web_fetch', 'Fetch a URL and return its readable text (docs, issues, changelogs).', { url: { type: 'string' } }, ['url']),
  fn('ask_user', 'Ask the user a question when you truly cannot continue without them.', { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } }, ['question']),
  fn('exit_plan_mode', 'Plan mode only: present your finished plan for approval. If approved, you may start editing.', { plan: { type: 'string', description: 'The plan in markdown.' } }, ['plan']),
];

function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = g.indexOf('}', i); if (end > i) { re += '(' + g.slice(i + 1, end).split(',').map(x => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; } else re += '\\{'; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

class Orbiter {
  constructor({ agent, store, emit }) {
    this.agent = agent;
    this.store = store;
    this.emit = emit || (() => {});
    this.dir = path.join(store.dir, 'orbiter');
    this.themesDir = path.join(store.dir, 'themes');
    for (const d of [this.dir, this.themesDir]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }
    this.busy = new Map(); // session id -> { step, started }
  }

  // ----- sessions -----
  _index() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'sessions.json'), 'utf8')); } catch { return []; } }
  _saveIndex(l) { fs.writeFileSync(path.join(this.dir, 'sessions.json'), JSON.stringify(l, null, 2)); }
  sessions() { return this._index().sort((a, b) => (b.updated || 0) - (a.updated || 0)).map(s => ({ ...s, busy: this.busy.has(s.id), step: (this.busy.get(s.id) || {}).step || '' })); }
  session(id) { return this._index().find(s => s.id === id) || null; }
  createSession({ folder, name, tier, mode, projectId } = {}) {
    const s = this.store.getSettings();
    folder = folder || s.orbiterLastFolder || path.join(os.homedir(), 'Documents');
    const sess = { id: uid(), name: name || path.basename(folder) || 'Session', folder, tier: tier !== undefined && tier !== null ? tier : (s.orbiterTier ?? ''), mode: mode || s.orbiterMode || 'ask', projectId: projectId || null, created: Date.now(), updated: Date.now(), todos: [], tokens: 0, last: '' };
    const l = this._index(); l.push(sess); this._saveIndex(l);
    try { this.store.saveSettings({ orbiterLastFolder: folder }); } catch {}
    this.emit({ type: 'orbiter_sessions' });
    return sess;
  }
  updateSession(id, patch) {
    const l = this._index().map(x => (x.id === id ? { ...x, ...patch, updated: Date.now() } : x));
    this._saveIndex(l); this.emit({ type: 'orbiter_sessions' });
    return l.find(x => x.id === id) || null;
  }
  deleteSession(id) {
    this.stop(id);
    this._saveIndex(this._index().filter(x => x.id !== id));
    try { fs.rmSync(path.join(this.dir, id), { recursive: true, force: true }); } catch {}
    this.emit({ type: 'orbiter_sessions' });
  }
  thread(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, id, 'thread.json'), 'utf8')); } catch { return []; } }
  saveThread(id, t) { fs.mkdirSync(path.join(this.dir, id), { recursive: true }); fs.writeFileSync(path.join(this.dir, id, 'thread.json'), JSON.stringify(t.slice(-600))); }
  diffs(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, id, 'diffs.json'), 'utf8')); } catch { return []; } }
  clearThread(id) { this.saveThread(id, []); this._saveCheckpoints(id, []); try { fs.unlinkSync(path.join(this.dir, id, 'diffs.json')); } catch {} this.updateSession(id, { todos: [], last: '' }); }
  checkpoints(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, id, 'checkpoints.json'), 'utf8')); } catch { return []; } }
  _saveCheckpoints(id, c) { fs.mkdirSync(path.join(this.dir, id), { recursive: true }); fs.writeFileSync(path.join(this.dir, id, 'checkpoints.json'), JSON.stringify(c.slice(-60))); }

  // ----- models: Orbit's own tiers over any provider -----
  // Order of choice: the session's tier, then the project's pinned tier, then Orbiter's default, then the main model.
  tierSettings(tierId) { return this.agent.tierSettings(tierId); }

  // ----- memory: ORBITER.md (and AGENTS.md / CLAUDE.md) from the user folder and the project -----
  memoryFiles(folder) {
    const out = [];
    const userFile = path.join(this.store.dir, 'ORBITER.md');
    const add = (p, scope) => { try { if (fs.existsSync(p)) out.push({ path: p, scope, text: fs.readFileSync(p, 'utf8').slice(0, 12000) }); } catch {} };
    add(userFile, 'user');
    for (const n of ['ORBITER.md', 'AGENTS.md', 'CLAUDE.md', '.orbiter/ORBITER.md']) add(path.join(folder, n), 'project');
    add(path.join(folder, 'ORBITER.local.md'), 'local');
    return out;
  }

  _system(sess) {
    const mem = this.memoryFiles(sess.folder).map(m => `<memory scope="${m.scope}" file="${m.path}">\n${m.text}\n</memory>`).join('\n');
    const mode = MODES.find(m => m.id === sess.mode) || MODES[0];
    let git = '';
    try { if (fs.existsSync(path.join(sess.folder, '.git'))) git = 'This folder is a git repository.'; } catch {}
    const todos = (sess.todos || []).length ? `\nCurrent todo list:\n${sess.todos.map(t => `- [${t.status}] ${t.content}`).join('\n')}` : '';
    return `You are Orbiter, the coding agent inside Orbit (a Windows desktop app made by Affan). You work like a senior engineer pair-programming in one folder.

Working folder: ${sess.folder}
Platform: ${process.platform} (${process.platform === 'win32' ? 'commands run in PowerShell' : 'commands run in bash'}). Date: ${new Date().toDateString()}. ${git}
Permission mode: ${mode.name}. ${mode.blurb}${sess.mode === 'plan' ? '\nPLAN MODE: only read, search and think. Do not edit or run commands that change anything. When the plan is ready, call exit_plan_mode with it.' : ''}

How you work:
- Explore before you change: glob/grep/read the relevant files first. Never guess at code you haven't read.
- Be fast: batch independent glob/grep/read_file/web calls into ONE step (they run in parallel). Read several files at once instead of one per step. Don't re-read a file you just wrote or read.
- Keep tool output small: grep with a path/glob filter, read_file with offset/limit on big files, quiet flags on commands.
- Run the slow checks (full test suite, build) once at the end, not after every edit.
- Make the smallest correct change. Match the existing style. Don't add comments that narrate the change.
- Prefer edit_file / multi_edit over rewriting whole files. Read a file before editing it.
- For any job with 3 or more steps, keep a todo list with todo_write and update it as you go.
- Verify: run the tests, build or linter that the project already has. Fix what you broke.
- Never commit, push, or delete files unless asked. Never print secrets.
- Be brief in chat. Lead with what you did or found; use file:line references. No preamble.
${mem ? '\nProject and user memory (follow it):\n' + mem : ''}${todos}`; // todos change mid-task; _loop keeps the first system prompt of a task, and todo_write results carry the live list
  }

  // ----- tools -----
  _tools(sess, lane) {
    const root = sess.folder;
    const abs = (p) => { const x = String(p || '.').replace(/^~(?=$|[\\/])/, os.homedir()); return path.isAbsolute(x) ? x : path.join(root, x); };
    const rel = (p) => path.relative(root, p) || '.';
    const readSet = this._readSet || (this._readSet = new Map());
    const seen = readSet.get(sess.id) || new Set(); readSet.set(sess.id, seen);
    const self = this;
    const mode = () => (self.session(sess.id) || sess).mode;
    const allowed = async (name, title, detail) => {
      const m = mode();
      if (m === 'plan' && !READ_ONLY.has(name)) throw new Error('Plan mode: nothing can change yet. Finish the plan and call exit_plan_mode.');
      if (m === 'bypass') return true;
      if (EDIT_TOOLS.has(name) && (m === 'acceptEdits' || m === 'auto')) return true;
      if (name === 'bash' && m === 'auto' && !RISKY.test(detail)) return true;
      if (name === 'bash' && this._allowList(sess).some(r => detail.startsWith(r))) return true;
      const ok = await this.agent.requestApproval(lane, title, detail);
      if (!ok) throw new Error('The user said no. Ask what they want instead, or try another way.');
      return true;
    };
    const snapshot = (file) => {
      const cps = this.checkpoints(sess.id); const cp = cps[cps.length - 1]; if (!cp) return;
      if (cp.files.some(f => f.path === file)) return;
      let before = null; try { before = fs.readFileSync(file, 'utf8'); } catch {}
      cp.files.push({ path: file, before }); this._saveCheckpoints(sess.id, cps);
    };
    const diffOut = (file, before, after) => {
      const info = { path: file, rel: rel(file), before: before == null ? null : String(before).slice(0, 60000), after: String(after).slice(0, 60000) };
      this.emit({ type: 'orbiter_diff', session: sess.id, ...info });
      try { const df = path.join(this.dir, sess.id, 'diffs.json'); let l = []; try { l = JSON.parse(fs.readFileSync(df, 'utf8')); } catch {} l.push({ ...info, at: Date.now() }); fs.writeFileSync(df, JSON.stringify(l.slice(-80))); } catch {}
      const added = after.split('\n').length - (before == null ? 0 : before.split('\n').length);
      return `${before == null ? 'Created' : 'Updated'} ${rel(file)} (${after.split('\n').length} lines, ${added >= 0 ? '+' : ''}${added}).`;
    };
    const walk = (dir, out, max = 4000) => {
      let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length >= max) return;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), out, max); }
        else out.push(path.join(dir, e.name));
      }
    };
    const T = {
      async read_file({ path: p, offset, limit }) {
        const f = abs(p); const text = fs.readFileSync(f, 'utf8'); seen.add(f);
        const lines = text.split('\n'); const start = Math.max(1, Number(offset) || 1); const n = Math.min(Number(limit) || 2000, 4000);
        const body = lines.slice(start - 1, start - 1 + n).map((l, i) => `${String(start + i).padStart(5)}  ${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`).join('\n');
        return `${rel(f)} (${lines.length} lines)\n${body}${start - 1 + n < lines.length ? `\n… ${lines.length - (start - 1 + n)} more lines (use offset)` : ''}`;
      },
      async list_dir({ path: p }) {
        const d = abs(p);
        return fs.readdirSync(d, { withFileTypes: true }).filter(e => !SKIP_DIRS.has(e.name)).map(e => (e.isDirectory() ? e.name + '/' : e.name)).sort().join('\n') || '(empty)';
      },
      async glob({ pattern }) {
        const re = globToRe(String(pattern).replace(/\\/g, '/').replace(/^\.\//, '')); const all = []; walk(root, all);
        const hits = all.map(f => ({ f, r: rel(f).replace(/\\/g, '/') })).filter(x => re.test(x.r) || (!pattern.includes('/') && re.test(path.basename(x.r))));
        hits.sort((a, b) => { try { return fs.statSync(b.f).mtimeMs - fs.statSync(a.f).mtimeMs; } catch { return 0; } });
        return hits.slice(0, 200).map(x => x.r).join('\n') + (hits.length > 200 ? `\n… ${hits.length - 200} more` : '') || 'No files match.';
      },
      async grep({ pattern, path: p, glob: g, ignore_case }) {
        const re = new RegExp(pattern, ignore_case ? 'i' : ''); const start = abs(p || '.'); const files = [];
        if (fs.existsSync(start) && fs.statSync(start).isFile()) files.push(start); else walk(start, files);
        const gre = g ? globToRe(g.replace(/\\/g, '/')) : null; const out = [];
        for (const f of files) {
          if (gre && !gre.test(path.basename(f)) && !gre.test(rel(f).replace(/\\/g, '/'))) continue;
          let st; try { st = fs.statSync(f); } catch { continue; } if (st.size > 1.5e6) continue;
          let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; } if (text.includes('\u0000')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && out.length < 300; i++) if (re.test(lines[i])) out.push(`${rel(f)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          if (out.length >= 300) break;
        }
        return out.join('\n') || 'No matches.';
      },
      async write_file({ path: p, content }) {
        const f = abs(p); const exists = fs.existsSync(f); const before = exists ? fs.readFileSync(f, 'utf8') : null;
        if (exists && !seen.has(f)) throw new Error(`Read ${rel(f)} before overwriting it.`);
        await allowed('write_file', `${exists ? 'Overwrite' : 'Create'} ${rel(f)}`, String(content).slice(0, 1500));
        snapshot(f); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); seen.add(f);
        return diffOut(f, before, content);
      },
      async edit_file({ path: p, old_string, new_string, replace_all }) {
        return T.multi_edit({ path: p, edits: [{ old_string, new_string, replace_all }] });
      },
      async multi_edit({ path: p, edits }) {
        const f = abs(p); if (!fs.existsSync(f)) throw new Error(`${rel(f)} doesn't exist. Use write_file to create it.`);
        if (!seen.has(f)) throw new Error(`Read ${rel(f)} before editing it.`);
        const before = fs.readFileSync(f, 'utf8'); let after = before;
        for (const e of edits || []) {
          if (e.old_string === e.new_string) throw new Error('old_string and new_string are the same.');
          const count = after.split(e.old_string).length - 1;
          if (!count) throw new Error(`old_string not found in ${rel(f)}. Re-read the file; whitespace must match exactly.`);
          if (count > 1 && !e.replace_all) throw new Error(`old_string appears ${count} times in ${rel(f)}. Add more context or set replace_all.`);
          after = e.replace_all ? after.split(e.old_string).join(e.new_string) : after.replace(e.old_string, () => e.new_string);
        }
        await allowed('edit_file', `Edit ${rel(f)}`, (edits || []).map(e => `- ${String(e.old_string).slice(0, 300)}\n+ ${String(e.new_string).slice(0, 300)}`).join('\n\n'));
        snapshot(f); fs.writeFileSync(f, after);
        return diffOut(f, before, after);
      },
      async bash({ command, timeout_sec, description }) {
        await allowed('bash', description ? `Run: ${description}` : 'Run a command', command);
        const win = process.platform === 'win32';
        const ms = Math.min(Number(timeout_sec) || 120, 600) * 1000;
        return new Promise((resolve) => {
          const child = win ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: root, windowsHide: true }) : spawn('bash', ['-lc', command], { cwd: root });
          let out = ''; const cap = (d) => { out += d.toString(); if (out.length > 60000) out = out.slice(-60000); self.emit({ type: 'orbiter_output', session: sess.id, text: d.toString() }); };
          child.stdout.on('data', cap); child.stderr.on('data', cap);
          const t = setTimeout(() => { try { child.kill(); } catch {} out += `\n(stopped after ${ms / 1000}s)`; }, ms);
          const ctl = self.agent.ctls.get(lane); if (ctl) ctl.signal.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });
          child.on('close', (code) => { clearTimeout(t); resolve(`exit ${code}\n${out.trim().slice(-14000) || '(no output)'}`); });
          child.on('error', (e) => { clearTimeout(t); resolve(`Error: ${e.message}`); });
        });
      },
      async todo_write({ todos }) {
        const list = (todos || []).map(t => ({ content: String(t.content || '').slice(0, 200), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
        self.updateSession(sess.id, { todos: list }); self.emit({ type: 'orbiter_todos', session: sess.id, todos: list });
        return `Todo list updated (${list.filter(t => t.status === 'completed').length}/${list.length} done):\n${list.map(t => `- [${t.status}] ${t.content}`).join('\n')}`;
      },
      async web_search(a) { return self.agent.tools.web_search(a); },
      async web_fetch({ url }) { return self.agent.tools.fetch_url({ url }); },
      async ask_user({ question, choices }) { const a = await self.agent.askUser(question, choices, lane); return `The user answered: ${a}`; },
      async exit_plan_mode({ plan }) {
        self.emit({ type: 'orbiter_plan', session: sess.id, plan });
        const ok = await self.agent.requestApproval(lane, 'Approve this plan?', plan);
        if (!ok) return 'The user did not approve the plan. Ask what to change, and stay in plan mode.';
        self.updateSession(sess.id, { mode: 'acceptEdits' });
        return 'Plan approved. Mode is now Accept edits. Start working through it with a todo list.';
      },
    };
    return T;
  }
  _allowList(sess) { const s = this.store.getSettings(); return (s.orbiterAllow || []).map(String).filter(Boolean); }

  // ----- running -----
  async send(id, text, { handoff } = {}) {
    let sess = this.session(id); if (!sess) throw new Error('No such session.');
    if (this.busy.has(id)) { (this._queue || (this._queue = new Map())).set(id, [...(this._queue.get(id) || []), text]); return { queued: true }; }
    const lane = 'orb-' + id;
    const thread = this.thread(id);
    const cps = this.checkpoints(id); cps.push({ id: uid(), at: Date.now(), prompt: String(text).slice(0, 140), threadLen: thread.length, files: [] }); this._saveCheckpoints(id, cps);
    const userMsg = { role: 'user', content: handoff ? `${text}\n\n<handoff from="Orbit chat">\n${handoff}\n</handoff>` : text, display: text, ui: true, at: Date.now(), checkpoint: cps[cps.length - 1].id };
    thread.push(userMsg); this.saveThread(id, thread);
    this.busy.set(id, { step: 'Thinking', started: Date.now() });
    const emit = (e) => this.emit({ ...e, session: id });
    emit({ type: 'orbiter_busy', busy: true });
    const tools = this._tools(sess, lane);
    const tier = this.tierSettings(sess.tier);
    const before = this.store.getUsage().tokensToday || 0;
    try {
      const res = await this.agent._loop({
        lane, emit, settings: tier.settings, model: tier.model, maxSteps: 80, streamToUI: true,
        pick: () => { const t = this.tierSettings((this.session(id) || sess).tier); return { settings: t.settings, model: t.model }; },
        system: () => this._system(this.session(id) || sess),
        context: () => this.agent._contextMessages(this.thread(id), 120, (Number(this.store.getSettings().contextBudget) || 24000) * 2, 'orb-' + id),
        append: (m) => { const t = this.thread(id); t.push({ ...m, ui: m.role === 'assistant' ? true : m.ui }); this.saveThread(id, t); },
        tools, schemas: SCHEMAS,
        onStep: (label) => { this.busy.set(id, { ...(this.busy.get(id) || {}), step: label }); emit({ type: 'orbiter_step', label }); },
      });
      const reply = res.text || (res.limit ? `Stopped after ${res.limit} steps. Say "continue" to keep going.` : 'Done.');
      const t = this.thread(id); t.push({ role: 'assistant', content: reply, ui: true, at: Date.now(), id: res.msgId }); this.saveThread(id, t);
      emit({ type: 'assistant_end', id: res.msgId, text: reply });
      this.updateSession(id, { last: reply.slice(0, 160), tokens: (sess.tokens || 0) + Math.max(0, (this.store.getUsage().tokensToday || 0) - before) });
      return { text: reply };
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Stopped.' : `Error: ${e.message}`;
      const t = this.thread(id); t.push({ role: 'assistant', content: msg, ui: true, at: Date.now() }); this.saveThread(id, t);
      emit({ type: 'error', text: msg });
      return { text: msg, error: true };
    } finally {
      this.busy.delete(id); this.agent.ctls.delete(lane);
      emit({ type: 'orbiter_busy', busy: false });
      const q = this._queue && this._queue.get(id);
      if (q && q.length) { this._queue.set(id, []); setTimeout(() => this.send(id, q.join('\n\n')), 50); }
    }
  }
  stop(id) { const ctl = this.agent.ctls.get('orb-' + id); if (ctl) ctl.abort(); if (this._queue) this._queue.delete(id); return !!ctl; }

  // Undo everything since a checkpoint: restore the files it touched and cut the conversation back.
  rewind(id, checkpointId, { code = true, chat = true } = {}) {
    if (this.busy.has(id)) throw new Error('Stop the session first.');
    const cps = this.checkpoints(id); const i = cps.findIndex(c => c.id === checkpointId); if (i < 0) throw new Error('Checkpoint not found.');
    const restored = [];
    if (code) for (let k = cps.length - 1; k >= i; k--) for (const f of cps[k].files) {
      try { if (f.before == null) { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } else fs.writeFileSync(f.path, f.before); restored.push(f.path); } catch {}
    }
    if (chat) this.saveThread(id, this.thread(id).slice(0, cps[i].threadLen));
    this._saveCheckpoints(id, cps.slice(0, i));
    this.emit({ type: 'orbiter_rewound', session: id });
    return { restored: [...new Set(restored)].length, prompt: cps[i].prompt };
  }

  // Squash the conversation into a summary to free context (/compact).
  async compact(id, focus) {
    const t = this.thread(id); if (t.length < 4) return 'Nothing to compact yet.';
    const tier = this.tierSettings('spark');
    const transcript = t.filter(m => m.role !== 'tool').map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 1500) : '[media]'}`).join('\n').slice(-40000);
    const res = await this.agent._completeChain(tier.settings, tier.model, [{ role: 'system', content: 'Summarise this coding session so work can continue: goal, decisions, files changed, current state, next steps. Be specific, under 400 words.' + (focus ? ' Focus on: ' + focus : '') }, { role: 'user', content: transcript }], uid(), false, new AbortController(), [], () => {});
    this.store.addUsage(res.tokens);
    this.saveThread(id, [{ role: 'user', content: `<summary of earlier session>\n${res.content}\n</summary>`, display: 'Conversation compacted', ui: true, compact: true, at: Date.now() }]);
    return res.content;
  }

  // /init: write an ORBITER.md for the folder.
  async init(id) { return this.send(id, 'Look through this codebase and create ORBITER.md in the project root: how to build, test and run it, the layout of the important folders, code conventions, and gotchas. Keep it under 80 lines. If ORBITER.md, AGENTS.md or CLAUDE.md already exists, improve it instead.'); }

  // What chat sees when the user asks "what is Orbiter doing?"
  statusText() {
    const l = this.sessions();
    if (!l.length) return 'Orbiter has no sessions yet.';
    return l.slice(0, 8).map(s => {
      const done = (s.todos || []).filter(t => t.status === 'completed').length;
      return `- ${s.name} (${s.folder}) · ${s.busy ? 'WORKING: ' + s.step : 'idle'} · mode ${s.mode} · ${s.tier}${(s.todos || []).length ? ` · todos ${done}/${s.todos.length}` : ''}${s.last ? ` · last: ${s.last.slice(0, 120)}` : ''}`;
    }).join('\n');
  }

  // ----- themes: built-in plus custom JSON files in %APPDATA%\Orbit\themes -----
  themes() {
    const custom = [];
    try {
      for (const f of fs.readdirSync(this.themesDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.themesDir, f), 'utf8'));
          let backdropUrl = '';
          if (j.backdrop) { // a picture next to the JSON file, shown behind the window
            const pic = path.join(this.themesDir, path.basename(String(j.backdrop))); const ext = path.extname(pic).slice(1).toLowerCase().replace('jpg', 'jpeg');
            if (['png', 'jpeg', 'webp', 'gif'].includes(ext) && fs.existsSync(pic) && fs.statSync(pic).size < 6e6) backdropUrl = `data:image/${ext};base64,${fs.readFileSync(pic).toString('base64')}`;
          }
          custom.push({ id: 'custom:' + f.replace(/\.json$/, ''), name: j.name || f.replace(/\.json$/, ''), base: j.base || 'orbit-dark', overrides: j.overrides || {}, scene: j.scene || '', backdropUrl });
        } catch {}
      }
    } catch {}
    return custom;
  }
  saveTheme(slug, data) {
    slug = String(slug || 'my-theme').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'my-theme';
    fs.writeFileSync(path.join(this.themesDir, slug + '.json'), JSON.stringify({ name: data.name || slug, base: data.base || 'orbit-dark', ...(data.scene ? { scene: String(data.scene) } : {}), ...(data.backdrop ? { backdrop: String(data.backdrop) } : {}), overrides: data.overrides || {} }, null, 2));
    return 'custom:' + slug;
  }
}

module.exports = { Orbiter, TIERS, MODES, SCHEMAS, globToRe, RISKY };
