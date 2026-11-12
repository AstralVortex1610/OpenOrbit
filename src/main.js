// Orbit — main process: window, tray, notifications, settings, scheduler, IPC.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, globalShortcut, nativeImage, safeStorage, shell, powerMonitor, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Agent } = require('./agent');
const { Store } = require('./store');
const { Scheduler } = require('./scheduler');
const { Phone } = require('./phone');
const { Live } = require('./live');
const { VoiceCache } = require('./voice-cache');
const { Updater, updateInProgress } = require('./updater');
// Lets the on-device voice models use several CPU threads.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

let win = null;
let tray = null;
let quitting = false;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

const store = new Store(app.getPath('userData'), safeStorage);
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const updater = new Updater({ app, send: (c, p) => send(c, p) });
// Quit for real so the update can replace the files: close windows, stop helpers, and force exit if anything hangs.
updater.onQuit = () => { quitting = true; setTimeout(() => app.exit(0), 3000); try { app.quit(); } catch { app.exit(0); } };

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: (body || '').slice(0, 240), icon: ICON, silent: false });
  n.on('click', () => { showWindow(); if (onClick) onClick(); });
  n.show();
}

let live = null;
const agent = new Agent({
  store,
  emit: (evt) => { send('agent:event', evt); if (live) live.onAgentEvent(evt); },
  // Orbit reaching out: a desktop notification when the window is not in front,
  // and a phone ping when the user is away from the laptop (or always, if they chose that).
  reachOut: (title, body, meta = {}) => {
    const focused = win && win.isVisible() && win.isFocused();
    if (!focused) notify(title, body);
    if (shouldPingPhone(focused)) phone.send({ title, body, ...meta });
  },
});

function userAway() {
  const s = store.getSettings();
  let idle = 0, locked = false;
  try { idle = powerMonitor.getSystemIdleTime(); locked = powerMonitor.getSystemIdleState(60) === 'locked'; } catch {}
  return locked || idle >= (Number(s.phoneIdleMinutes) || 3) * 60;
}
function shouldPingPhone(focused) {
  const s = store.getSettings();
  if (!s.ntfyEnabled && !s.telegramEnabled) return false;
  if (s.phoneWhen === 'never') return false;
  if (s.phoneWhen === 'always') return !focused || userAway();
  return userAway();
}

live = new Live({ store, agent, emit: (evt) => send('live:event', evt) });

const phone = new Phone({
  store,
  log: (m) => console.log('[phone]', m),
  onAnswer: (id, text) => {
    if (String(id).startsWith('test-')) { notify('Orbit', `Your phone replied: ${text}`); send('agent:event', { type: 'notice', title: 'Phone connected', text: `Your phone replied "${text}". Replies work.` }); return; }
    if (!agent.answerFromPhone(id, text)) agent.handleUser(text, [], 'phone');
  },
  onMessage: (text, channel) => agent.handleUser(text, [], channel),
});
phone.onPaired = () => send('settings:changed', { why: 'telegram' });
agent.onResolved = (id) => phone.answered(id);
agent.replyToPhone = (text, channel) => {
  const s = store.getSettings();
  if (channel === 'telegram' && s.telegramEnabled) phone._sendTelegram('Orbit', text).catch(() => {});
  else if (channel === 'ntfy' && s.ntfyEnabled) phone._sendNtfy('Orbit', text).catch(() => {});
};

const scheduler = new Scheduler({
  store,
  run: async (task) => {
    await agent.runProactive(task);
    send('tasks:changed', store.getTasks());
  },
});
agent.scheduler = scheduler;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 580,
    backgroundColor: '#1a1917',
    title: 'Orbit',
    icon: ICON,
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keeps the wake word listening while Orbit sits in the tray
      autoplayPolicy: 'no-user-gesture-required', // Orbit's voice can speak a finished task without a click
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('close', (e) => {
    if (!quitting && store.getSettings().closeToTray !== false) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Orbit');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Orbit', click: showWindow },
    { label: 'Run morning brief now', click: () => { const t = store.getTasks().find(x => x.id === 'morning-brief'); if (t) scheduler.runNow(t.id); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// ---------- IPC ----------
ipcMain.handle('settings:get', () => store.getSettingsForUI());
ipcMain.handle('settings:save', (_e, s) => {
  store.saveSettings(s);
  const cur = store.getSettings();
  app.setLoginItemSettings({ openAtLogin: !!cur.startWithWindows, args: ['--hidden'] });
  registerHotkey();
  ensurePhoneIds();
  phone.restart();
  updater.startAuto(cur.autoUpdate !== false);
  return store.getSettingsForUI();
});
// ---------- files Orbit made ----------
const fileOk = (p) => typeof p === 'string' && fs.existsSync(p);
ipcMain.handle('file:open', (_e, p) => fileOk(p) ? shell.openPath(p) : 'File not found');
ipcMain.handle('file:reveal', (_e, p) => { if (fileOk(p)) shell.showItemInFolder(p); return fileOk(p); });
ipcMain.handle('file:saveAs', async (_e, p) => {
  if (!fileOk(p)) return { ok: false, error: 'File not found' };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.basename(p)) });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.copyFileSync(p, r.filePath); return { ok: true, path: r.filePath };
});
// ---------- connectors ----------
ipcMain.handle('connectors:status', () => agent.connectors.status());
ipcMain.handle('connectors:presets', () => require('./connectors').API_PRESETS);
ipcMain.handle('connectors:save', async (_e, patch) => {
  const out = {};
  if (Array.isArray(patch.mcpServers)) out.mcpServers = patch.mcpServers;
  if (Array.isArray(patch.apiConnectors)) out.apiConnectors = patch.apiConnectors;
  store.saveSettings(out);
  agent.connectors.restart().catch(() => {});
  return { settings: store.getSettingsForUI(), status: agent.connectors.status() };
});
ipcMain.handle('connectors:restart', async () => { agent.connectors.stopAll(); agent.connectors.clients.clear(); await agent.connectors.restart(); return agent.connectors.status(); });
ipcMain.handle('update:state', () => updater.state);
ipcMain.handle('update:check', () => updater.check(false));
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('phone:test', async () => { try { const n = await phone.test(); return n ? { ok: true, message: `Sent to ${n} channel${n > 1 ? 's' : ''}. Check your phone.` } : { ok: false, message: 'Turn on ntfy or Telegram first (and pair Telegram).' }; } catch (e) { return { ok: false, message: e.message }; } });
ipcMain.handle('phone:status', () => phone.status);
ipcMain.handle('phone:newTopic', () => { store.saveSettings({ ntfyTopic: Phone.newTopic() }); phone.restart(); return store.getSettingsForUI(); });
ipcMain.handle('phone:unpairTelegram', () => { store.saveSettings({ telegramChatId: '', telegramPairCode: Phone.newPairCode() }); phone.restart(); return store.getSettingsForUI(); });
ipcMain.handle('wake:model', () => fs.readFileSync(path.join(__dirname, '..', 'assets', 'vosk-model-small-en-us-0.15.tar.gz')));
ipcMain.handle('wake:heard', () => { showWindow(); return true; });

function ensurePhoneIds() {
  const s = store.getSettings();
  const patch = {};
  if (!s.ntfyTopic) patch.ntfyTopic = Phone.newTopic();
  if (!s.telegramPairCode) patch.telegramPairCode = Phone.newPairCode();
  if (Object.keys(patch).length) { try { store.saveSettings(patch); } catch (e) { console.error(e); } }
}
ipcMain.handle('live:status', () => live.status());
ipcMain.handle('live:start', async () => { try { return { ok: true, ...(await live.start()) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('live:stop', () => { live.stop(); return true; });
ipcMain.handle('live:mute', (_e, m) => { live.setMuted(m); return true; });
ipcMain.on('live:audio', (_e, buf) => live.audio(buf));
ipcMain.handle('voice:turn', (_e, t) => { live.turn(t || {}); return true; });
ipcMain.handle('voice:interrupt', (_e, t) => { live.interrupt(t || {}); return true; });
ipcMain.on('voice:talking', (_e, on) => live.talking(on));
ipcMain.on('voice:opener', () => live.opener());
ipcMain.handle('voice:brainTest', async () => {
  const s = store.getSettings(); const t0 = Date.now();
  const model = s.voiceModel || s.fastModel || s.model;
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(String(s.baseUrl || '').replace(/\/+$/, '') + '/chat/completions', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with just: ok' }], max_tokens: 16 }) });
    clearTimeout(tm);
    const body = await r.text();
    if (!r.ok) return { ok: false, error: `${model}: HTTP ${r.status} ${body.slice(0, 200)}` };
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: `${model}: ${e.name === 'AbortError' ? 'no answer in 25 s' : e.message}` }; }
});
ipcMain.on('voice:speaking', (_e, on) => live.speakingNow(on));
ipcMain.handle('voice:log', (_e, line) => { try { require('fs').appendFileSync(require('path').join(app.getPath('userData'), 'voice.log'), `[${new Date().toISOString()}] ${String(line).slice(0, 2000)}\n`); } catch {} return true; });
let voiceCache = null;
ipcMain.handle('voice:base', async () => {
  if (!voiceCache) voiceCache = new VoiceCache(path.join(app.getPath('userData'), 'models'), (p) => send('voice:progress', p));
  return voiceCache.start();
});
ipcMain.handle('voice:cached', () => {
  const d = path.join(app.getPath('userData'), 'models', 'hf', 'onnx-community');
  return ['silero-vad', 'Kokoro-82M-v1.0-ONNX'].every(m => fs.existsSync(path.join(d, m)));
});
// ----- Home, projects, updates -----
const hub = agent.hub;
ipcMain.handle('ui:scope', (_e, scope) => { agent.viewScope = scope || 'main'; return true; });
ipcMain.handle('projects:list', () => hub.projects().map(p => ({ ...p, busy: agent.projectBusy(p.id), files: hub.listFiles(p.id).length })));
ipcMain.handle('projects:get', (_e, id) => { const p = hub.project(id); return p ? { ...p, busy: agent.projectBusy(id), folder: hub.filesDir(id), fileList: hub.listFiles(id).slice(0, 100).map(({ path: _p, ...f }) => f) } : null; });
ipcMain.handle('projects:create', (_e, d) => hub.createProject(d || {}));
ipcMain.handle('projects:update', (_e, id, patch) => { const allowed = {}; for (const k of ['name', 'about', 'brief']) if (patch && typeof patch[k] === 'string') allowed[k] = patch[k]; return hub.updateProject(id, allowed); });
ipcMain.handle('projects:delete', (_e, id) => { agent.stopLane('proj-' + id); hub.deleteProject(id); return true; });
ipcMain.handle('projects:thread', (_e, id) => hub.thread(id).filter(m => m.ui));
ipcMain.handle('projects:clear', (_e, id) => { hub.clearThread(id); return true; });
ipcMain.handle('projects:send', (_e, id, text, att) => { agent.projectSend(id, text, att || []); return true; });
ipcMain.handle('projects:stop', (_e, id) => agent.stopLane('proj-' + id));
ipcMain.handle('projects:openFolder', (_e, id) => { const d = hub.filesDir(id); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); return true; });
ipcMain.handle('projects:openFile', (_e, id, name) => { const f = hub.listFiles(id).find(x => x.name === name); if (f) shell.openPath(f.path); return !!f; });
ipcMain.handle('panels:list', () => hub.panels());
ipcMain.handle('panels:create', (_e, d) => { const p = hub.addPanel({ title: d.title || 'New panel', prompt: d.prompt, everyMinutes: d.everyMinutes }); agent.refreshPanel(p.id); return p; });
ipcMain.handle('panels:update', (_e, id, patch) => { const allowed = {}; for (const k of ['title', 'prompt', 'everyMinutes']) if (patch && patch[k] !== undefined) allowed[k] = patch[k]; const p = hub.updatePanel(id, allowed); if (allowed.prompt) agent.refreshPanel(id); return p; });
ipcMain.handle('panels:move', (_e, id, dir) => { hub.movePanel(id, dir); return hub.panels(); });
ipcMain.handle('panels:delete', (_e, id) => { hub.deletePanel(id); return true; });
ipcMain.handle('panels:refresh', (_e, id) => { agent.refreshPanel(id); return true; });
ipcMain.handle('updates:list', () => hub.updates());
ipcMain.handle('updates:read', (_e, ids) => { hub.markRead(ids || null); return hub.unread(); });
ipcMain.handle('updates:clear', () => { hub.clearUpdates(); return true; });
ipcMain.handle('home:summary', () => ({ unread: hub.unread(), tasks: store.getTasks().filter(t => t.enabled).length, projects: hub.projects().length, busy: agent.mainBusy, workers: agent.workers.size }));
ipcMain.handle('settings:test', async () => agent.testConnection());
ipcMain.handle('settings:models', async () => { try { return { ok: true, models: await agent.listModels() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('thread:get', () => store.getThread().filter(m => m.ui));
ipcMain.handle('thread:clear', () => { store.clearThread(); return true; });
ipcMain.handle('chat:send', async (_e, text, attachments) => { agent.handleUser(text, attachments || []); return true; });
ipcMain.handle('chat:stop', () => { agent.stop(); return true; });
ipcMain.handle('lane:stop', (_e, id) => agent.stopLane(id));
ipcMain.handle('google:connect', async () => {
  try { const email = await agent.google.connect((url) => shell.openExternal(url)); send('settings:changed'); return { ok: true, email }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('google:disconnect', () => { agent.google.disconnect(); return store.getSettingsForUI(); });
ipcMain.handle('approval:answer', (_e, id, approved) => agent.resolvePending(id, { approved }));
ipcMain.handle('question:answer', (_e, id, answer) => agent.resolvePending(id, { answer }));
ipcMain.handle('tasks:get', () => store.getTasks());
ipcMain.handle('tasks:toggle', (_e, id, enabled) => { store.updateTask(id, { enabled }); scheduler.reload(); return store.getTasks(); });
ipcMain.handle('tasks:delete', (_e, id) => { store.deleteTask(id); scheduler.reload(); return store.getTasks(); });
ipcMain.handle('tasks:runNow', (_e, id) => { scheduler.runNow(id); return true; });
ipcMain.handle('memory:list', () => store.listMemory());
ipcMain.handle('memory:read', (_e, name) => store.readMemory(name));
ipcMain.handle('memory:write', (_e, name, content) => { store.writeMemory(name, content); return true; });
ipcMain.handle('memory:openFolder', () => shell.openPath(store.memoryDir));
ipcMain.handle('usage:get', () => store.getUsage());
ipcMain.handle('voice:transcribe', async (_e, arrayBuffer, mime) => agent.transcribe(Buffer.from(arrayBuffer), mime));
ipcMain.handle('win:minimize', () => win.minimize());
ipcMain.handle('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.handle('win:close', () => win.close());
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dataDir: app.getPath('userData') }));

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = store.getSettings().hotkey || 'Control+Shift+O';
  try { globalShortcut.register(key, () => { if (win && win.isVisible() && win.isFocused()) win.hide(); else { showWindow(); send('ui:focusInput'); } }); } catch (_) {}
}

// ---------- lifecycle ----------
if (updateInProgress(app)) {
  // An update is being copied in right now; it reopens Orbit itself when done.
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.affan.orbit');
    createWindow();
    createTray();
    registerHotkey();
    scheduler.start();
    setTimeout(() => agent.panelTick(), 8000);
    setInterval(() => agent.panelTick(), 60 * 1000);
    ensurePhoneIds();
    phone.restart();
    updater.startAuto(store.getSettings().autoUpdate !== false);
    agent.connectors.onChange = () => send('connectors:changed', agent.connectors.status());
    setTimeout(() => agent.connectors.restart().catch(e => console.error(e)), 3000);
  });
  app.on('before-quit', () => {
  if (agent && agent.browser) agent.browser.close(); live.stop(); phone.stopAll(); try { agent.connectors.stopAll(); } catch {} quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', (e) => { /* stay alive in tray */ });
}
