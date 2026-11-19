// Orbit Phone Link — wiring into Orbit's main process.
// A paired phone calls the same IPC handlers the desktop window uses (captured in main.js as they are
// registered), minus the few that only make sense at the PC. Events the window gets are forwarded too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PhoneLink } = require('./index');

// Things a phone may not do from afar, and what it is told instead.
const BLOCKED = {
  'passwords:reveal': 'Saved passwords can only be shown on the laptop.',
  'google:connect': 'Connect Google on the laptop (it opens a browser there).',
  'sandbox:reset': 'Reset the sandbox on the laptop.',
  'orbiter:pickFolder': 'Pick folders on the laptop.',
  'memory:openFolder': 'Folders open on the laptop.',
  'projects:openFolder': 'Folders open on the laptop.',
  'wake:model': 'The wake word runs on the laptop only.',
  'wake:heard': '', 'win:minimize': '', 'win:maximize': '', 'win:close': '',
  'live:start': 'Live calls run on the laptop. On the phone, use the mic button and spoken replies.',
  'live:stop': '', 'live:mute': '', 'voice:turn': '', 'voice:interrupt': '', 'voice:base': '', 'voice:cached': '', 'voice:brainTest': '', 'voice:log': '',
  'file:open': '', 'file:reveal': '', 'file:saveAs': '', 'projects:openFile': '', 'orbiter:openPath': '', // the phone downloads instead (link:file)
};
// Events the phone mirrors. (Voice-call and wake-word events stay on the PC.)
const FORWARD = new Set(['agent:event', 'tasks:changed', 'settings:changed', 'update:state', 'connectors:changed', 'computer:frame', 'orbiter:event', 'ui:orbiter', 'link:info']);
const SENSITIVE = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)([\\/]|$)|[\\/]gcloud([\\/]|$)/i;
const SENSITIVE_FILE = /^(settings|phone-link|passwords|vault|credentials|tokens?)(\.json|\.bak|\.tmp)?$/i;
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', json: 'application/json', zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const MAX_DOWN = 200 * 1024 * 1024, MAX_UP = 50 * 1024 * 1024;

function install({ app, ipcMain, handlers, store, agent, updater, powerMonitor, getWin, resourcesPath, log }) {
  log = log || ((m) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'phone-link.log'), `${new Date().toISOString()} ${m}\n`); } catch {} });
  const laptopName = () => { const h = String(os.hostname() || '').trim(); return !h || /^\(?none\)?$|^localhost$/i.test(h) ? 'your laptop' : h; };
  const info = () => {
    const s = store.getSettings();
    return { assistantName: s.assistantName || 'Orbit', userName: s.userName || '', version: app.getVersion(), laptop: laptopName(), platform: process.platform, theme: s.theme || 'dark', update: updater ? { status: updater.state.status, latest: updater.state.latest || '' } : null };
  };

  // Files a phone may download: Orbit's own data folder (minus settings and secrets) and the user's home,
  // minus key/credential folders. Everything else stays on the PC.
  function fileAllowed(p) {
    let real; try { real = fs.realpathSync(p); } catch { return null; }
    const st = fs.statSync(real); if (!st.isFile()) return null;
    if (SENSITIVE.test(real) || SENSITIVE_FILE.test(path.basename(real))) return null;
    const under = (root) => { try { const r = fs.realpathSync(root); const rel = path.relative(r, real); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); } catch { return false; } };
    const data = app.getPath('userData');
    if (under(data)) return /[\\/](projects|workspace|attachments|outputs|memory)[\\/]/i.test(real.slice(data.length)) ? { real, st } : null;
    if (under(os.homedir())) { if (/[\\/]AppData[\\/]/i.test(real)) return null; return { real, st }; }
    return null;
  }
  async function readForPhone(arg) {
    let p = arg;
    if (arg && typeof arg === 'object' && arg.project) { const f = agent.hub.listFiles(arg.project).find(x => x.name === arg.name); p = f && f.path; }
    if (typeof p !== 'string' || !p) throw new Error('File not found');
    const ok = fileAllowed(p); if (!ok) throw new Error('That file is not available to the phone.');
    if (ok.st.size > MAX_DOWN) throw new Error('File is over 200 MB; open it on the laptop.');
    const ext = path.extname(ok.real).slice(1).toLowerCase();
    return { name: path.basename(ok.real), size: ok.st.size, mime: MIME[ext] || 'application/octet-stream', data: fs.readFileSync(ok.real) };
  }
  function saveUpload(u) {
    if (!u || !u.data) throw new Error('No file');
    const buf = Buffer.isBuffer(u.data) ? u.data : Buffer.from(u.data);
    if (buf.length > MAX_UP) throw new Error('Files from the phone are limited to 50 MB.');
    const dir = path.join(store.workDir, 'attachments', 'from-phone'); fs.mkdirSync(dir, { recursive: true });
    const base = String(u.name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').slice(0, 80) || 'file';
    const ext = path.extname(base); const stem = base.slice(0, base.length - ext.length);
    let f = path.join(dir, base); for (let i = 2; fs.existsSync(f); i++) f = path.join(dir, `${stem} (${i})${ext}`);
    fs.writeFileSync(f, buf);
    return { path: f, name: path.basename(f), size: buf.length };
  }

  async function invoke(ch, args, ctx) {
    if (ch === 'link:info') return info();
    if (ch === 'link:file') return readForPhone(args[0]);
    if (ch === 'link:upload') return saveUpload(args[0]);
    if (ch.startsWith('phoneLink:')) throw new Error('Phone Link is managed on the laptop.');
    if (Object.prototype.hasOwnProperty.call(BLOCKED, ch)) { if (BLOCKED[ch]) throw new Error(BLOCKED[ch]); return null; }
    if (ch === 'settings:save') { const s = { ...(args[0] || {}) }; for (const k of Object.keys(s)) if (/^phoneLink/.test(k)) delete s[k]; args = [s]; }
    if (ch === 'sandbox:share' && !args[0]) throw new Error('Type the folder path, or share it from the laptop.');
    if (ch === 'voice:transcribe' && args[0] && !(args[0] instanceof ArrayBuffer)) { const b = Buffer.from(args[0]); args = [b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), args[1]]; }
    const fn = handlers.get(ch);
    if (!fn) throw new Error(`"${ch}" isn't available from the phone`);
    return fn({ sender: null, senderFrame: null, phone: ctx && ctx.device }, ...args);
  }

  const link = new PhoneLink({ store, dir: app.getPath('userData'), invoke, info, log, resourcesPath });
  const toWindow = (ch, p) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, p); };
  link.on('status', (st) => toWindow('phoneLink:status', st));

  // Settings changes (from the PC or a phone) can switch Phone Link on/off or change its transport.
  const save = store.saveSettings.bind(store);
  store.saveSettings = (s) => {
    const r = save(s);
    clearTimeout(link._applyT); link._applyT = setTimeout(() => { link.apply(); link.emitEvent('link:info', info()); }, 50);
    return r;
  };

  ipcMain.handle('phoneLink:status', () => link.statusWithQr());
  ipcMain.handle('phoneLink:pair', async () => { await link.startPairing(); return link.statusWithQr(); });
  ipcMain.handle('phoneLink:cancel', () => link.cancelPairing());
  ipcMain.handle('phoneLink:revoke', (_e, id) => link.revoke(id).status);
  ipcMain.handle('phoneLink:rename', (_e, id, name) => link.rename(id, name));

  // ---- the auto-updater and Phone Link ----
  // 1) a phone in use counts as "someone is using Orbit": no surprise restart mid-conversation;
  // 2) right before the update restarts Orbit, phones are told (banner "Laptop is updating") and the
  //    sealed rendezvous note says so too; cloudflared is stopped so its file isn't locked;
  // 3) after the restart the link comes back with the same pairings (they live in userData, not the app folder).
  if (updater) {
    const apply = updater.apply.bind(updater);
    updater.apply = (o) => { try { link.announce('updating'); } catch {} return apply(o); };
  }
  link.inUse = () => link.recentlyActive(3 * 60 * 1000);

  // ---- sleep / wake ----
  try {
    powerMonitor.on('suspend', () => { link.announce('sleeping'); });
    powerMonitor.on('resume', () => { setTimeout(() => { link.appState = 'online'; if (link.tunnel) link.tunnel.restart(); link.publish('resume', 'online'); }, 4000); });
  } catch {}

  link.forward = (ch, p) => { if (FORWARD.has(ch)) link.emitEvent(ch, p); };
  app.on('before-quit', () => { link.stop(app.__orbitUpdating ? 'updating' : 'offline').catch(() => {}); });
  return link;
}

module.exports = { install, BLOCKED, FORWARD };
