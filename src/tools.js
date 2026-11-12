// Orbit — tools the agent can use on the laptop and the web.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const TOOL_SCHEMAS = [
  fn('run_command', 'Run a shell command on this computer (PowerShell on Windows, bash elsewhere) and return its output. Use for anything the OS can do: system info, launching programs, git, python, file operations, installs.', {
    command: { type: 'string', description: 'The command to run.' },
    cwd: { type: 'string', description: 'Working directory. Defaults to the user home folder.' },
    timeout_sec: { type: 'number', description: 'Max seconds before it is stopped (default 120).' },
  }, ['command']),
  fn('read_file', 'Read a text file from disk.', { path: { type: 'string' } }, ['path']),
  fn('write_file', 'Create or overwrite a text file. Relative paths go in Orbit\'s working folder.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('list_dir', 'List a folder\'s contents with sizes.', { path: { type: 'string' } }, ['path']),
  fn('web_search', 'Search the web. Returns titles, links and snippets.', { query: { type: 'string' } }, ['query']),
  fn('fetch_url', 'Download a web page and return its readable text.', { url: { type: 'string' } }, ['url']),
  fn('open', 'Open a URL in the browser, or a file, folder or app on this computer.', { target: { type: 'string' } }, ['target']),
  fn('screenshot', 'Take a screenshot of the main screen so you can see what is on it.', {}),
  fn('browser_navigate', 'Open a page in Orbit\'s own browser window (Edge/Chrome on this laptop, stays signed in between tasks). Returns the page\'s interactive elements with numbered refs and its text.', { url: { type: 'string' } }, ['url']),
  fn('browser_snapshot', 'Re-read the current browser page: numbered interactive elements plus page text.', {}),
  fn('browser_click', 'Click an element by its ref number from the latest snapshot. Set consequential=true when the click buys, pays, books, sends, posts, deletes or submits something binding; the user must approve it first.', { ref: { type: 'number' }, consequential: { type: 'boolean' } }, ['ref']),
  fn('password_save', 'Save a login the user gave you (encrypted on this PC) so you can sign in for them later. Call it as soon as they share one.', { site: { type: 'string', description: 'The website, e.g. github.com' }, username: { type: 'string', description: 'Username, email or phone used to sign in' }, password: { type: 'string' }, url: { type: 'string', description: 'Sign-in page URL, if known' }, note: { type: 'string' } }, ['site']),
  fn('password_list', 'List saved logins (site, username and id; never passwords). Pass site to find the login for one website.', { site: { type: 'string' } }),
  fn('browser_login', 'Sign in on the page open in the browser with a saved login: types the username and password straight into the page (you never see the password) and submits. Use the id from password_list. Refs are optional; fields are found automatically.', { id: { type: 'string' }, username_ref: { type: 'number' }, password_ref: { type: 'number' }, submit: { type: 'boolean' } }, ['id']),
  fn('browser_type', 'Type into an input, textarea or select (by ref). submit=true presses Enter after.', { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']),
  fn('browser_press', 'Press a key in the browser, e.g. Enter, Escape, Tab, ArrowDown, Control+A.', { key: { type: 'string' } }, ['key']),
  fn('browser_scroll', 'Scroll the page up or down by about one screen.', { direction: { type: 'string', enum: ['up', 'down'] } }, ['direction']),
  fn('browser_back', 'Go back one page.', {}),
  fn('browser_tab', 'List open tabs (no index) or switch to one by index.', { index: { type: 'number' } }),
  fn('browser_screenshot', 'See the browser page as an image, for layouts, images or anything the text snapshot misses.', {}),
  fn('browser_close', 'Close the browser window when the task is finished.', {}),
  fn('windows_list', 'List open app windows on this Windows laptop (handle | app | title).', {}),
  fn('window_focus', 'Bring a window to the front, by title, app name or handle.', { window: { type: 'string' } }, ['window']),
  fn('ui_snapshot', 'Read the buttons, fields, menus and list items of a Windows app window (by title, app name or handle; omit to reuse the last window). Returns numbered refs.', { window: { type: 'string' } }),
  fn('ui_click', 'Click a control in a Windows app by its ref from the latest ui_snapshot. Set consequential=true if it sends, pays, deletes or submits something binding.', { ref: { type: 'number' }, right: { type: 'boolean' }, double: { type: 'boolean' }, consequential: { type: 'boolean' } }, ['ref']),
  fn('ui_type', 'Type text into a field in a Windows app by ref. submit=true presses Enter.', { ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']),
  fn('keys_send', 'Send keystrokes to the focused window. SendKeys syntax: ^ Ctrl, % Alt, + Shift, {ENTER}, {TAB}, {ESC}, {F5}, e.g. ^s to save, %{F4} to close.', { keys: { type: 'string' } }, ['keys']),
  fn('mouse_click', 'Click at a point on the screen, using x,y pixel coordinates from your latest screenshot. Last resort when a control has no ref.', { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } }, ['x', 'y']),
  fn('memory_list', 'List your memory files.', {}),
  fn('memory_read', 'Read a memory file, e.g. USER.md or projects/jee.md.', { name: { type: 'string' } }, ['name']),
  fn('memory_write', 'Replace a memory file\'s whole content. Read it first so you keep what is still true.', { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
  fn('memory_append', 'Add a line or section to a memory file (creates it if missing).', { name: { type: 'string' }, text: { type: 'string' } }, ['name', 'text']),
  fn('skill_read', 'Read a skill\'s instructions.', { name: { type: 'string' } }, ['name']),
  fn('skill_write', 'Save or update a skill: markdown with a title, a "When:" line, and steps.', { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
  fn('ask_user', 'Ask the user a question and wait for the answer. Sends a desktop notification if they are away. Give 2 to 4 short likely choices when you can.', {
    question: { type: 'string' },
    choices: { type: 'array', items: { type: 'string' } },
  }, ['question']),
  fn('notify_user', 'Send the user a desktop notification right now, without waiting for a reply.', { title: { type: 'string' }, message: { type: 'string' } }, ['message']),
  fn('schedule_task', 'Schedule yourself to do something later. kind: once (needs at, ISO local datetime), daily (needs time HH:MM), weekly (time + days 0-6, Sunday=0), interval (everyHours). The prompt is what you will be told when it fires.', {
    name: { type: 'string' },
    prompt: { type: 'string' },
    kind: { type: 'string', enum: ['once', 'daily', 'weekly', 'interval'] },
    at: { type: 'string' },
    time: { type: 'string' },
    days: { type: 'array', items: { type: 'number' } },
    everyHours: { type: 'number' },
  }, ['name', 'prompt', 'kind']),
  fn('list_tasks', 'List scheduled tasks.', {}),
  fn('cancel_task', 'Delete a scheduled task by id.', { id: { type: 'string' } }, ['id']),
  fn('start_task', 'Start a background task that runs in parallel with its own browser tab, while you keep going. Use it to split independent work (research three options at once) or to hand off long jobs so you stay free to talk. Give a complete, self-contained instruction.', {
    task: { type: 'string', description: 'Everything the task needs to know, with every detail the user gave.' },
    label: { type: 'string', description: 'A 2 to 5 word name shown to the user.' },
  }, ['task']),
  fn('task_status', 'See what is running right now: the main task and every background task with its latest step.', {}),
  fn('wait_tasks', 'Wait for background tasks to finish and get their results.', { ids: { type: 'array', items: { type: 'string' } }, timeout_sec: { type: 'number', description: 'Default 300.' } }, ['ids']),
  fn('stop_task', 'Stop a running task by id ("main" for the main task).', { id: { type: 'string' } }, ['id']),
  fn('forward_to_main', 'Hand the user\'s message to the main task that is running, because it is about that task (a follow-up, extra detail, correction or question about it). The main task will act on it and reply.', { message: { type: 'string', description: 'The user\'s words, as they said them.' } }, ['message']),
  fn('tell_main', 'Pass a correction or extra detail from the user to the main task that is running right now.', { message: { type: 'string' } }, ['message']),
  fn('gmail_search', 'Search the user\'s Gmail with Gmail search syntax (from:, subject:, is:unread, newer_than:2d). Returns id, from, subject, date and snippet.', { query: { type: 'string' }, max: { type: 'number', description: 'Default 10, max 25.' } }, ['query']),
  fn('gmail_read', 'Read one email by id: headers and body text.', { id: { type: 'string' } }, ['id']),
  fn('gmail_send', 'Send an email from the user\'s Gmail (they approve it first), or save it as a draft with draft_only. To reply, pass reply_to_id.', {
    to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text.' },
    reply_to_id: { type: 'string' }, draft_only: { type: 'boolean' },
  }, ['to', 'subject', 'body']),
  fn('calendar_events', 'List events on the user\'s Google Calendar. Defaults to the next 7 days.', { start: { type: 'string', description: 'ISO date or datetime. Default now.' }, days: { type: 'number' }, query: { type: 'string' } }),
  fn('calendar_create', 'Create a Google Calendar event. Times are ISO local datetimes like 2026-11-02T17:00.', {
    summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' },
    attendees: { type: 'array', items: { type: 'string' }, description: 'Emails to invite.' }, all_day: { type: 'boolean' },
  }, ['summary', 'start']),
  fn('calendar_delete', 'Delete a Google Calendar event by id.', { id: { type: 'string' } }, ['id']),
  fn('generate_image', 'Make an image from a text prompt. Saves a PNG to Pictures\\Orbit and shows it in the chat.', { prompt: { type: 'string' }, size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] }, name: { type: 'string', description: 'File name without extension.' } }, ['prompt']),
  fn('publish_site', 'Publish a folder with an index.html (a page you wrote with write_file) as a live public website on Netlify, and return its link. Publishing the same name again updates it.', { folder: { type: 'string', description: 'Folder path; relative paths are in Orbit\'s working folder.' }, name: { type: 'string', description: 'Short site name, letters and dashes.' } }, ['folder', 'name']),
  fn('make_file', 'Make a finished file from your research and show it in the chat as a card the user can open or save. Formats: pdf (default, a designed report), pptx (slides: each ## heading becomes a slide, tables get their own slide), docx (Word), html, md, txt, csv (from the first markdown table, or rows). Research first, then write the whole thing as markdown in content: ## sections, short paragraphs, bullet lists and | tables |. Put source links in sources, not in the body.', {
    format: { type: 'string', enum: ['pdf', 'pptx', 'docx', 'html', 'md', 'txt', 'csv'] },
    title: { type: 'string' },
    subtitle: { type: 'string', description: 'One line under the title.' },
    kind: { type: 'string', description: 'Small label on the cover, e.g. Research report, Comparison, Brief, Study notes, Osint report.' },
    summary: { type: 'string', description: 'The answer in two or three sentences, shown first.' },
    content: { type: 'string', description: 'The body in markdown.' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Source URLs, in the order cited.' },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'CSV only: rows including the header row.' },
    filename: { type: 'string', description: 'Without extension. Defaults to the title.' },
  }, ['title', 'content']),
  fn('view_image', 'Look at an image file on this computer or an image URL. With a question, a vision model answers it; otherwise the image is shown to you.', { path: { type: 'string' }, question: { type: 'string' } }, ['path']),
  fn('connectors_list', 'List the user\'s connectors (MCP servers and custom APIs) with their status and tools.', {}),
  fn('panel_create', 'Put a live panel on the user\'s Home screen: something glanceable that changes over time (a price, weather, exam countdown, unread mail, GitHub trending, a score). Orbit fills it with real values and refreshes it on its own.', {
    title: { type: 'string', description: '2-4 words.' },
    what: { type: 'string', description: 'Exactly what the panel shows and where the values come from, with every detail the user gave (city, ticker, date, account).' },
    every_minutes: { type: 'number', description: 'How often to refresh. Pick the slowest honest pace: 60 for prices, 180 for weather, 1440 for daily things. 0 = only when asked. Minimum 30.' },
  }, ['title', 'what']),
  fn('panel_list', 'List the panels on the user\'s Home with their ids.', {}),
  fn('panel_update', 'Change a Home panel: its title, what it shows, or how often it refreshes. It refreshes right after.', { id: { type: 'string' }, title: { type: 'string' }, what: { type: 'string' }, every_minutes: { type: 'number' } }, ['id']),
  fn('panel_delete', 'Remove a panel from Home.', { id: { type: 'string' } }, ['id']),
  fn('project_create', 'Create a project: a separate space with its own chat, files folder and brief, for a body of work that will keep going (an app, an exam plan, a client).', { name: { type: 'string' }, about: { type: 'string', description: 'One or two lines on what it is for.' } }, ['name']),
  fn('project_list', 'List the user\'s projects.', {}),
  fn('project_brief', 'Replace this project\'s brief (its standing memory: goal, decisions, files, open threads). Send the whole brief in markdown. Only works inside a project chat.', { content: { type: 'string' } }, ['content']),
];

const RISKY = /\b(rm|rmdir|rd|del|erase|Remove-Item|ri|format|diskpart|shutdown|Restart-Computer|Stop-Computer|Stop-Process|taskkill|kill|reg\s+(delete|add)|Set-ItemProperty|Set-ExecutionPolicy|mv|move|Move-Item|Rename-Item|ren|git\s+push|git\s+reset|npm\s+(i|install|uninstall)|pip\s+(install|uninstall)|winget|choco|Invoke-WebRequest|iwr|curl|wget|Send-MailMessage|New-Service|sc\s+delete|icacls|takeown|cipher|bcdedit|schtasks)\b|>\s*[^&|]/i;

function expand(p, base) {
  if (!p) return base;
  let s = String(p).replace(/^~(?=$|[\\/])/, os.homedir());
  s = s.replace(/%([^%]+)%/g, (_, v) => process.env[v] || _);
  return path.isAbsolute(s) ? s : path.join(base, s);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const { Browser } = require('./browser');
const docs = require('./docs');
const { buildOsint, OSINT_SCHEMAS } = require('./osint');

// Orbit's own tools plus whatever is switched on: Osint (beta) and the user's connectors.
function allSchemas(agent) {
  const s = agent.store.getSettings();
  return [...TOOL_SCHEMAS, ...(s.osintBeta ? OSINT_SCHEMAS : []), ...(agent.connectors ? agent.connectors.schemas() : [])];
}
const { WinUI } = require('./winui');

function buildTools(agent, lane = { id: 'main' }) {
  const store = agent.store;
  const mainBrowser = agent.browser || (agent.browser = new Browser(store));
  // Background tasks get their own tab in the same signed-in browser, so they never fight over a page.
  const browser = lane.id === 'main' ? mainBrowser : new Browser(store, mainBrowser);
  lane.browser = browser;
  const winui = agent.winui || (agent.winui = new WinUI());
  // There is one mouse and keyboard: desktop control from parallel tasks takes turns.
  const ui = (fn) => (...a) => { const run = (agent._uiLock || Promise.resolve()).then(() => fn(...a)); agent._uiLock = run.catch(() => {}); return run; };
  let shotMap = null; // screenshot pixel -> physical screen pixel
  const needApproval = (risky) => {
    const mode = store.getSettings().approvalMode;
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return risky;
  };

  const withLoginHint = (snap) => {
    try {
      const m = String(snap).match(/\nURL: (\S+)/); if (!m) return snap;
      const l = agent.passwords.list(m[1]); if (!l.length) return snap;
      return snap.replace(/\nURL: \S+/, (u) => `${u}\nSaved login for this site: ${l.map(x => `id ${x.id} (${x.username || 'no username'})`).join(', ')}. Use browser_login to sign in.`);
    } catch { return snap; }
  };
  const tools = {
    async make_file(a) {
      const { format, data } = await docs.render({ ...a });
      const dir = lane.project && agent.hub ? agent.hub.filesDir(lane.project) : path.join(os.homedir(), 'Documents', 'Orbit');
      fs.mkdirSync(dir, { recursive: true });
      const base = String(a.filename || a.title).replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Orbit file';
      let file = path.join(dir, `${base}.${format}`); let n = 2;
      while (fs.existsSync(file)) file = path.join(dir, `${base} (${n++}).${format}`);
      fs.writeFileSync(file, data);
      const info = { path: file, name: path.basename(file), format, size: data.length, title: a.title };
      if (lane.project) agent.emit({ type: 'projects_changed', project: lane.project });
      return { text: `Saved ${info.name} (${(data.length / 1024).toFixed(0)} KB) to ${dir}. It's shown in the chat as a card; just say it's ready, no need to repeat its contents.\n<!--orbit-file ${JSON.stringify(info)}-->`, file: info };
    },
    async view_image({ path: p, question }) {
      let dataUrl;
      if (/^https?:/.test(p)) { const r = await fetch(p); if (!r.ok) throw new Error(`HTTP ${r.status}`); const ct = r.headers.get('content-type') || 'image/jpeg'; dataUrl = `data:${ct};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`; }
      else { const full = expand(p, store.workDir); const ext = path.extname(full).slice(1).toLowerCase().replace('jpg', 'jpeg'); dataUrl = `data:image/${ext || 'png'};base64,${fs.readFileSync(full).toString('base64')}`; }
      const s = store.getSettings();
      if (question && s.visionModel) return agent.askVision(dataUrl, question);
      return { text: 'The image is attached next.', image: dataUrl };
    },
    async connectors_list() {
      if (!agent.connectors) return 'Connectors are not available.';
      const st = agent.connectors.status();
      const lines = [...st.mcp.map(m => `MCP ${m.name}: ${m.status}${m.error ? ' (' + m.error + ')' : ''}${m.toolNames.length ? ' · tools: ' + m.toolNames.join(', ') : ''}`), ...st.api.map(a => `API ${a.name}: ${a.enabled ? 'on' : 'off'} · tool ${a.tool}`)];
      return (lines.join('\n') || 'No connectors yet.') + `\nGoogle (Gmail, Calendar): ${agent.google && agent.google.connected() ? 'connected' : 'not connected'}. The user adds connectors in the Connectors screen.`;
    },
    ...buildOsint({ agent, store, lane, browser }),
    async run_command({ command, cwd, timeout_sec }) {
      if (!command) throw new Error('No command given.');
      if (needApproval(RISKY.test(command))) {
        const ok = await agent.requestApproval(lane.id, 'Run this command?', command);
        if (!ok) return 'The user declined to run this command. Ask what they would like instead.';
      }
      const isWin = process.platform === 'win32';
      const shellCmd = isWin ? 'powershell.exe' : 'bash';
      const args = isWin ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] : ['-lc', command];
      const dir = expand(cwd, os.homedir());
      const limit = Math.min(Number(timeout_sec) || 120, 900) * 1000;
      return await new Promise((resolve) => {
        let out = '';
        const p = spawn(shellCmd, args, { cwd: fs.existsSync(dir) ? dir : os.homedir(), windowsHide: true });
        const timer = setTimeout(() => { p.kill(); out += `\n[stopped after ${limit / 1000}s]`; }, limit);
        p.stdout.on('data', d => { out += d.toString(); });
        p.stderr.on('data', d => { out += d.toString(); });
        p.on('error', e => { clearTimeout(timer); resolve(`Error: ${e.message}`); });
        p.on('close', code => {
          clearTimeout(timer);
          if (out.length > 12000) out = out.slice(0, 6000) + '\n…[output trimmed]…\n' + out.slice(-5000);
          resolve(`exit code ${code}\n${out.trim() || '(no output)'}`);
        });
      });
    },

    async read_file({ path: p }) {
      const full = expand(p, store.workDir);
      const stat = fs.statSync(full);
      if (stat.size > 2_000_000) return `Error: file is ${Math.round(stat.size / 1e6)} MB, too big to read whole.`;
      return fs.readFileSync(full, 'utf8');
    },

    async write_file({ path: p, content }) {
      const full = expand(p, store.workDir);
      const inside = full.startsWith(store.workDir) || (agent.hub && full.startsWith(agent.hub.dir));
      const exists = fs.existsSync(full);
      if (needApproval(exists || !inside)) {
        const ok = await agent.requestApproval(lane.id, exists ? 'Overwrite this file?' : 'Create this file?', `${full}\n\n${String(content).slice(0, 400)}${String(content).length > 400 ? '…' : ''}`);
        if (!ok) return 'The user declined. The file was not written.';
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return `Saved ${full} (${Buffer.byteLength(content)} bytes).`;
    },

    async list_dir({ path: p }) {
      const full = expand(p, os.homedir());
      const items = fs.readdirSync(full, { withFileTypes: true }).slice(0, 300).map(d => {
        let size = '';
        try { if (d.isFile()) size = ` ${Math.round(fs.statSync(path.join(full, d.name)).size / 1024)} KB`; } catch {}
        return `${d.isDirectory() ? '[dir] ' : ''}${d.name}${size}`;
      });
      return `${full}\n${items.join('\n') || '(empty)'}`;
    },

    async web_search({ query }) {
      const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' },
      });
      const html = await r.text();
      const results = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && results.length < 8) {
        let url = m[1];
        const u = url.match(/uddg=([^&]+)/);
        if (u) url = decodeURIComponent(u[1]);
        results.push(`${results.length + 1}. ${htmlToText(m[2])}\n${url}\n${htmlToText(m[3])}`);
      }
      return results.length ? results.join('\n\n') : 'No results (the search page may have blocked the request). Try fetch_url on a site you know.';
    },

    async fetch_url({ url }) {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36' }, redirect: 'follow' });
      const type = r.headers.get('content-type') || '';
      const body = await r.text();
      const text = type.includes('html') ? htmlToText(body) : body;
      return `HTTP ${r.status} ${url}\n\n${text.slice(0, 12000)}`;
    },

    async open({ target }) {
      const { shell } = require('electron');
      if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) { await shell.openExternal(target); return `Opened ${target}`; }
      const full = expand(target, os.homedir());
      if (fs.existsSync(full)) { const err = await shell.openPath(full); return err ? `Error: ${err}` : `Opened ${full}`; }
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '', target], { windowsHide: true, detached: true });
        return `Asked Windows to start "${target}".`;
      }
      return `Error: could not find ${target}`;
    },

    async screenshot() {
      const { desktopCapturer, screen } = require('electron');
      const { width, height } = screen.getPrimaryDisplay().size;
      const scale = Math.min(1, 1600 / width);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
      if (!sources.length) return 'Error: no screen found.';
      const img = sources[0].thumbnail;
      const disp = screen.getPrimaryDisplay();
      shotMap = { k: disp.scaleFactor / scale, ox: disp.bounds.x * disp.scaleFactor, oy: disp.bounds.y * disp.scaleFactor };
      const dataUrl = 'data:image/jpeg;base64,' + img.toJPEG(70).toString('base64');
      return { text: `Screenshot taken (${img.getSize().width}x${img.getSize().height}). It is attached next.`, image: dataUrl };
    },

    async browser_navigate({ url }) { return withLoginHint(await browser.navigate(url)); },
    async browser_snapshot() { return withLoginHint(await browser.snapshot()); },
    async password_save(a) {
      const r = agent.passwords.save(a);
      if (a.password) agent.scrubSecret(a.password);
      agent.emit({ type: 'passwords_changed' });
      return `${r.isNew ? 'Saved' : 'Updated'} the ${r.site} login${r.username ? ` for ${r.username}` : ''} (id ${r.id}). It is encrypted on this PC and shows on the Passwords screen.`;
    },
    async password_list({ site }) {
      const l = agent.passwords.list(site);
      if (!l.length) return site ? `No saved login for ${site}. Ask the user for it (or they can add it on the Passwords screen).` : 'No saved logins yet.';
      return l.map(x => `${x.id} · ${x.site} · ${x.username || '(no username)'}${x.hasPassword ? '' : ' · no password saved'}${x.url ? ` · ${x.url}` : ''}${x.note ? ` · ${x.note}` : ''}`).join('\n');
    },
    async browser_login({ id, username_ref, password_ref, submit }) {
      const sec = agent.passwords.secret(id);
      if (!sec) return 'Error: no saved login with that id. Use password_list.';
      const out = await browser.login({ username: sec.username, password: sec.password }, { usernameRef: username_ref, passwordRef: password_ref, submit: submit !== false });
      return sec.password ? out.split(sec.password).join('••••••') : out;
    },
    async browser_click({ ref, consequential }) {
      if (consequential && store.getSettings().approvalMode !== 'never') {
        const ok = await agent.requestApproval(lane.id, 'Click this in the browser?', `Element ${ref} on ${browser.page ? browser.page.url() : 'the page'}`);
        if (!ok) return 'The user declined this click. Ask what they want instead.';
      }
      return browser.click(ref);
    },
    async browser_type({ ref, text, submit }) { return browser.type(ref, text, submit); },
    async browser_press({ key }) { return browser.press(key); },
    async browser_scroll({ direction }) { return browser.scroll(direction); },
    async browser_back() { return browser.back(); },
    async browser_tab({ index }) { return browser.tab(index); },
    async browser_screenshot() { return browser.screenshot(); },
    async browser_close() { return browser.close(); },

    async windows_list() { return winui.listWindows(); },
    async window_focus({ window }) { return winui.focus(window); },
    async ui_snapshot({ window }) { return winui.snapshot(window); },
    async ui_click({ ref, right, double, consequential }) {
      if (consequential && store.getSettings().approvalMode !== 'never') {
        const it = winui.refs.get(Number(ref));
        const ok = await agent.requestApproval(lane.id, 'Click this in an app?', it ? `${it.t} "${it.n || it.a}"` : `Control ${ref}`);
        if (!ok) return 'The user declined this click.';
      }
      return winui.click(ref, { right, double });
    },
    async ui_type({ ref, text, submit }) { return winui.type(ref, text, submit); },
    async keys_send({ keys }) {
      if (/%\{F4\}|\{DEL|\+\{DEL/i.test(keys) && needApproval(true)) {
        const ok = await agent.requestApproval(lane.id, 'Send these keys?', keys);
        if (!ok) return 'The user declined.';
      }
      return winui.keys(keys);
    },
    async mouse_click({ x, y, button, double }) {
      const m = shotMap || { k: 1, ox: 0, oy: 0 };
      return winui.mouseClick(m.ox + x * m.k, m.oy + y * m.k, button, double);
    },

    async memory_list() { return store.listMemory().map(f => `${f.name} (${f.size} bytes)`).join('\n') || '(no memory yet)'; },
    async memory_read({ name }) { return store.readMemory(name) ?? `No memory file called ${name}.`; },
    async memory_write({ name, content }) { store.writeMemory(name, content); agent.emit({ type: 'memory_changed' }); return `Saved ${name}.`; },
    async memory_append({ name, text }) {
      const cur = store.readMemory(name) || `# ${String(name).replace(/\.md$/, '')}\n`;
      store.writeMemory(name, cur.replace(/\s*$/, '\n') + text.trim() + '\n');
      agent.emit({ type: 'memory_changed' });
      return `Added to ${name}.`;
    },
    async skill_read({ name }) { return store.readSkill(name) ?? `No skill called ${name}.`; },
    async skill_write({ name, content }) { store.writeSkill(name, content); return `Saved skill ${name}.`; },

    async ask_user({ question, choices }) {
      const answer = await agent.askUser(question, choices, lane.id);
      return `The user answered: ${answer}`;
    },
    async notify_user({ title, message }) {
      agent.reachOut(title || 'Orbit', message);
      agent.emit({ type: 'notice', title: title || 'Orbit', text: message, lane: lane.id });
      agent.postUpdate({ kind: 'notice', title: title || 'Orbit', text: message });
      return 'Notification sent.';
    },

    async schedule_task(a) {
      const id = (a.name || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) + '-' + Date.now().toString(36).slice(-4);
      const task = { id, name: a.name, prompt: a.prompt, kind: a.kind, enabled: true, lastRun: null };
      if (a.kind === 'once') { if (!a.at || isNaN(new Date(a.at))) throw new Error('A once task needs "at" as a datetime, e.g. 2026-10-28T18:30.'); task.at = new Date(a.at).toISOString(); }
      if (a.kind === 'daily' || a.kind === 'weekly') { if (!/^\d{1,2}:\d{2}$/.test(a.time || '')) throw new Error('Needs "time" as HH:MM.'); task.time = a.time; }
      if (a.kind === 'weekly') task.days = a.days || [1];
      if (a.kind === 'interval') task.everyHours = Math.max(1, Number(a.everyHours) || 3);
      store.addTask(task);
      agent.emit({ type: 'tasks_changed' });
      return `Scheduled "${task.name}" (${task.id}).`;
    },
    async list_tasks() {
      return store.getTasks().map(t => `${t.id} | ${t.name} | ${t.kind} ${t.time || t.at || (t.everyHours ? 'every ' + t.everyHours + 'h' : '')} | ${t.enabled ? 'on' : 'off'}`).join('\n') || '(none)';
    },
    async cancel_task({ id }) { store.deleteTask(id); agent.emit({ type: 'tasks_changed' }); return `Cancelled ${id}.`; },

    // ----- parallel work -----
    async start_task({ task, label }) {
      if (!task) throw new Error('Describe the task.');
      const w = agent.startWorker({ task, label, parent: lane.id });
      return `Started background task ${w.id} ("${w.label}")${w.queued ? ', queued until a slot frees up' : ''}. It runs in parallel and its result is posted to the chat when done. Use wait_tasks if you need the result to continue.`;
    },
    async task_status() { return agent.statusText(); },
    async wait_tasks({ ids, timeout_sec }) { return agent.waitWorkers(ids, timeout_sec); },
    async stop_task({ id }) { return agent.stopLane(id); },
    async forward_to_main({ message }) {
      tools._forwarded = true;
      const how = agent.forwardToMain(String(message || ''), lane.source);
      return how === 'queued' ? 'The main task just finished, so this runs next as a follow-up. Tell the user you are on it.' : 'Forwarded. The main task will act on it and cover it in its reply. Tell the user in a few words.';
    },
    async tell_main({ message }) {
      if (!agent.mainBusy) return 'Nothing is running in the main task right now. Start a background task or answer directly.';
      agent.noteToMain(`(The user just added this, mid-task: ${message})`);
      return 'Passed to the running task. It will see it before its next step.';
    },

    // ----- Google (Gmail, Calendar) -----
    async gmail_search({ query, max }) { return agent.google.gmailSearch(query, max); },
    async gmail_read({ id }) { return agent.google.gmailRead(id); },
    async gmail_send(a) {
      const preview = `To: ${a.to}${a.cc ? `\nCc: ${a.cc}` : ''}\nSubject: ${a.subject}\n\n${String(a.body || '').slice(0, 600)}`;
      if (!a.draft_only && store.getSettings().approvalMode !== 'never') {
        const ok = await agent.requestApproval(lane.id, 'Send this email?', preview);
        if (!ok) return 'The user declined to send it. Ask what to change.';
      }
      return agent.google.gmailSend(a);
    },
    async calendar_events(a) { return agent.google.calendarList(a); },
    async calendar_create(a) {
      if (a.attendees && a.attendees.length && store.getSettings().approvalMode !== 'never') {
        const ok = await agent.requestApproval(lane.id, 'Create this event and invite people?', `${a.summary}\n${a.start} to ${a.end}\nInvites: ${a.attendees.join(', ')}`);
        if (!ok) return 'The user declined.';
      }
      return agent.google.calendarCreate(a);
    },
    async calendar_delete({ id }) {
      if (store.getSettings().approvalMode !== 'never') { const ok = await agent.requestApproval(lane.id, 'Delete this calendar event?', id); if (!ok) return 'The user declined.'; }
      return agent.google.calendarDelete(id);
    },

    // ----- make and publish -----
    async generate_image(a) { return agent.makeImage(a); },
    async publish_site({ folder, name }) {
      const dir = expand(folder, store.workDir);
      if (store.getSettings().approvalMode === 'always') { const ok = await agent.requestApproval(lane.id, 'Publish this folder as a public website?', dir); if (!ok) return 'The user declined.'; }
      return require('./publish').publish(store, dir, name);
    },
  };
  // ----- Home, projects -----
  const hub = agent.hub;
  Object.assign(tools, {
    async panel_create({ title, what, every_minutes }) {
      if (!what) throw new Error('Say what the panel should show.');
      const p = hub.addPanel({ title, prompt: what, everyMinutes: every_minutes });
      agent.emit({ type: 'panels_changed' });
      agent.refreshPanel(p.id);
      return `Added the "${p.title}" panel to Home (${p.id}). It's filling in now and refreshes ${p.everyMinutes ? `every ${p.everyMinutes} minutes` : 'when asked'}. Tell the user it's on their Home.`;
    },
    async panel_list() { return hub.panels().map(p => `${p.id} | ${p.title} | every ${p.everyMinutes || 'manual'} min | ${p.status} | shows: ${p.prompt.slice(0, 120)}`).join('\n') || '(no panels)'; },
    async panel_update({ id, title, what, every_minutes }) {
      if (!hub.panel(id)) throw new Error(`No panel ${id}. Use panel_list.`);
      const patch = {}; if (title) patch.title = title; if (what) patch.prompt = what; if (every_minutes !== undefined) patch.everyMinutes = every_minutes;
      hub.updatePanel(id, patch); agent.emit({ type: 'panels_changed' }); agent.refreshPanel(id);
      return 'Updated. It refreshes now.';
    },
    async panel_delete({ id }) { if (!hub.panel(id)) throw new Error(`No panel ${id}.`); hub.deletePanel(id); agent.emit({ type: 'panels_changed' }); return 'Removed from Home.'; },
    async project_create({ name, about }) { const p = hub.createProject({ name, about }); agent.emit({ type: 'projects_changed' }); return `Created project "${p.name}" (${p.id}). Its files folder: ${hub.filesDir(p.id)}. The user can open it from Projects.`; },
    async project_list() { return hub.projects().map(p => `${p.id} | ${p.name} | ${p.about || ''}`).join('\n') || '(no projects)'; },
    async project_brief({ content }) {
      if (!lane.project) throw new Error('project_brief only works inside a project chat.');
      hub.updateProject(lane.project, { brief: String(content || '').slice(0, 12000), updated: Date.now() });
      agent.emit({ type: 'projects_changed', project: lane.project });
      return 'Brief updated.';
    },
  });
  for (const k of ['windows_list', 'window_focus', 'ui_snapshot', 'ui_click', 'ui_type', 'keys_send', 'mouse_click', 'screenshot']) tools[k] = ui(tools[k]);
  // Connector tools (mcp_*, api_*) are looked up live, so a server added mid-chat just works.
  return new Proxy(tools, {
    get(t, name) {
      if (name in t || typeof name !== 'string' || !agent.connectors || !agent.connectors.has(name)) return t[name];
      return (args) => agent.connectors.call(name, args || {}, (title, detail) => agent.requestApproval(lane.id, title, detail), store.getSettings().approvalMode);
    },
  });
}

module.exports = { buildTools, TOOL_SCHEMAS, allSchemas };
