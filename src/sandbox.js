// Orbit — its own computer. A private Linux (WSL2 distro "orbit") where Orbit runs commands,
// installs tools and browses, out of your way. It sees none of your PC except folders you share,
// each Read only, Ask first (Orbit works on a copy, you approve changes) or Full access.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DISTRO = 'orbit';
const ROOTFS = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz';
const CDP_PORT = 9223;
const WIN = process.platform === 'win32' || process.env.ORBIT_SANDBOX_TEST === '1';
const MODES = { read: 'Read only', ask: 'Ask first', full: 'Full access' };

// One-time setup inside the sandbox (runs as root). Ends by writing /etc/orbit-ready.
const PROVISION = `set -e
export DEBIAN_FRONTEND=noninteractive
id orbit >/dev/null 2>&1 || useradd -m -s /bin/bash -u 1000 orbit
echo 'orbit ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/orbit
cat > /etc/wsl.conf <<'CONF'
[automount]
enabled=false
mountFsTab=false
[interop]
appendWindowsPath=false
[user]
default=orbit
[boot]
systemd=false
CONF
apt-get update -q
apt-get install -y -q curl ca-certificates git python3 python3-pip python3-venv build-essential unzip zip jq ripgrep poppler-utils
if ! command -v node >/dev/null; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y -q nodejs; fi
mkdir -p /opt/pw && export PLAYWRIGHT_BROWSERS_PATH=/opt/pw
npx -y playwright@1.49.1 install --with-deps chromium
chmod -R a+rx /opt/pw
mkdir -p /mnt/win /home/orbit/work && chown orbit:orbit /home/orbit/work
echo 'export PLAYWRIGHT_BROWSERS_PATH=/opt/pw' > /etc/profile.d/orbit.sh
date -Is > /etc/orbit-ready
`;

const safeName = (p) => String(p).replace(/^([A-Za-z]):\\?$/, '$1-drive').replace(/[\\/:]+$/, '').split(/[\\/]/).pop().replace(/[^\w.-]+/g, '_') || 'share';
const sq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

class Sandbox {
  constructor({ store, app, emit }) {
    this.store = store; this.app = app; this.emit = emit || (() => {});
    this.keep = null; this.busy = null; this.lastStatus = null;
  }
  get on() { return !!this.store.getSettings().sandboxOn; }
  get dir() { return path.join(this.app.getPath('userData'), 'sandbox'); }
  shares() { return (this.store.getSettings().sandboxShares || []).filter(s => s && s.path); }
  log(line) { this.emit({ type: 'computer_log', line: String(line).slice(0, 2000), at: Date.now() }); }

  // wsl.exe with UTF-8 output. Resolves { code, out }.
  wsl(args, { input, timeout = 120000, onData } = {}) {
    return new Promise((resolve) => {
      let out = '';
      let p; try { p = spawn('wsl.exe', args, { windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } }); } catch (e) { return resolve({ code: -1, out: e.message }); }
      const t = setTimeout(() => { try { p.kill(); } catch {} out += `\n[stopped after ${Math.round(timeout / 1000)}s]`; }, timeout);
      const take = d => { const s = d.toString().replace(/\u0000/g, ''); out += s; if (onData) onData(s); };
      p.stdout.on('data', take); p.stderr.on('data', take);
      p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
      p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
      if (input != null) { p.stdin.write(input); } p.stdin.end();
    });
  }

  async status() {
    if (!WIN) return (this.lastStatus = { state: 'unsupported', text: 'The sandbox needs Windows 10 or 11.' });
    if (this.busy) return (this.lastStatus = { state: 'setting_up', text: this.busy });
    const st = await this.wsl(['--status'], { timeout: 15000 });
    if (st.code !== 0 && /not installed|install|0x8007019e|not recognized|ENOENT/i.test(st.out)) return (this.lastStatus = { state: 'no_wsl', text: 'Windows Subsystem for Linux isn\'t installed yet. Set up installs it (needs admin once, then a restart).' });
    const list = await this.wsl(['-l', '-q'], { timeout: 15000 });
    if (!list.out.split(/\r?\n/).map(s => s.trim()).includes(DISTRO)) return (this.lastStatus = { state: 'not_set_up', text: 'Not set up yet. Set up downloads about 300 MB once.' });
    const ready = await this.wsl(['-d', DISTRO, '-u', 'root', '--', 'cat', '/etc/orbit-ready'], { timeout: 30000 });
    if (ready.code !== 0) return (this.lastStatus = { state: 'broken', text: 'Setup didn\'t finish. Press Set up to finish it.' });
    return (this.lastStatus = { state: 'ready', text: `Ready. ${this.shares().length ? this.shares().length + ' shared folder(s).' : 'No folders shared.'}` });
  }

  // Full setup, safe to run again (it resumes). step(text) reports progress.
  async setup() {
    if (this.busy) return this.status();
    const step = (t) => { this.busy = t; this.log('setup: ' + t); this.emit({ type: 'sandbox_state', state: 'setting_up', text: t }); };
    try {
      let st = await this.status();
      if (st.state === 'unsupported') return st;
      if (st.state === 'no_wsl') {
        step('Installing Windows Subsystem for Linux (approve the admin prompt)…');
        await this.wsl(['--install', '--no-distribution'], { timeout: 15 * 60000 }).then(async r => {
          if (r.code !== 0) await new Promise(res => { const p = spawn('powershell.exe', ['-NoProfile', '-Command', "Start-Process wsl.exe -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait"], { windowsHide: true }); p.on('close', res); p.on('error', res); });
        });
        this.busy = null;
        st = await this.status();
        if (st.state === 'no_wsl') return (this.lastStatus = { state: 'restart', text: 'Linux support is installed. Restart Windows, then press Set up again to finish.' });
      }
      fs.mkdirSync(this.dir, { recursive: true });
      if (st.state === 'not_set_up') {
        const tar = path.join(this.dir, 'rootfs.tar.gz');
        if (!fs.existsSync(tar) || fs.statSync(tar).size < 100e6) await this._download(ROOTFS, tar, (pct) => step(`Downloading Linux… ${pct}%`));
        step('Unpacking…');
        const imp = await this.wsl(['--import', DISTRO, path.join(this.dir, 'disk'), tar, '--version', '2'], { timeout: 10 * 60000 });
        if (imp.code !== 0) throw new Error('Could not create the sandbox: ' + imp.out.trim().slice(0, 300));
        try { fs.unlinkSync(tar); } catch {}
      }
      step('Installing Node, Python, git and the browser (a few minutes, once)…');
      const prov = await this.wsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-s'], { input: PROVISION, timeout: 30 * 60000, onData: (d) => d.split(/\r?\n/).filter(Boolean).slice(-2).forEach(l => this.log(l)) });
      if (prov.code !== 0) throw new Error('Setup inside the sandbox failed: ' + prov.out.trim().split(/\r?\n/).slice(-4).join(' · ').slice(0, 400));
      this._memoryCap();
      await this.wsl(['--manage', DISTRO, '--set-sparse', 'true'], { timeout: 30000 }); // freed space goes back to Windows (newer WSL)
      await this.wsl(['--terminate', DISTRO], { timeout: 30000 });
      this.busy = null;
      await this.warm();
      return this.status();
    } catch (e) {
      this.busy = null;
      return (this.lastStatus = { state: 'error', text: e.message });
    } finally { this.busy = null; this.emit({ type: 'sandbox_state', ...(this.lastStatus || {}) }); }
  }

  async _download(url, to, progress) {
    let fetcher = fetch; try { const { net } = require('electron'); if (net && net.fetch) fetcher = net.fetch; } catch {}
    const r = await fetcher(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    const total = Number(r.headers.get('content-length')) || 0; let got = 0, last = -1;
    const out = fs.createWriteStream(to + '.part');
    for await (let c of r.body) { c = Buffer.from(c); got += c.length; if (!out.write(c)) await new Promise(res => out.once('drain', res)); const pct = total ? Math.floor(got / total * 100) : 0; if (pct !== last && pct % 5 === 0) { last = pct; progress(pct); } }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    fs.renameSync(to + '.part', to);
  }

  // Cap WSL's memory so the laptop stays smooth. Only when the user hasn't set a cap themselves.
  _memoryCap() {
    try {
      const f = path.join(os.homedir(), '.wslconfig'); let s = ''; try { s = fs.readFileSync(f, 'utf8'); } catch {}
      if (/^\s*memory\s*=/im.test(s)) return;
      const gb = Math.max(2, Math.min(12, Number(this.store.getSettings().sandboxRamGb) || 4));
      s = /\[wsl2\]/i.test(s) ? s.replace(/\[wsl2\][^\n]*\n?/i, m => m.replace(/\n?$/, '\n') + `memory=${gb}GB\n`) : (s ? s.replace(/\s*$/, '\n\n') : '') + `[wsl2]\nmemory=${gb}GB\n`;
      fs.writeFileSync(f, s);
    } catch {}
  }

  // Keep the sandbox running while Orbit is open, so commands start instantly. Mounts shared folders.
  async warm() {
    if (!this.on || !WIN || (this.keep && this.keep.exitCode === null)) return;
    if ((await this.status()).state !== 'ready') return;
    this.keep = spawn('wsl.exe', ['-d', DISTRO, '--', 'sleep', 'infinity'], { windowsHide: true, stdio: 'ignore' });
    this.keep.on('exit', () => { this.keep = null; if (this.on && !this._stopping) setTimeout(() => this.warm().catch(() => {}), 5000); });
    await this.mountAll();
  }
  stop() { this._stopping = true; try { this.keep && this.keep.kill(); } catch {} this.keep = null; this._stopping = false; }

  async mountAll() {
    const lines = ['mkdir -p /mnt/win'];
    for (const s of this.shares()) {
      const at = '/mnt/win/' + safeName(s.path);
      const opt = s.mode === 'full' ? 'rw,metadata,uid=1000,gid=1000' : 'ro,uid=1000,gid=1000';
      lines.push(`mkdir -p ${sq(at)}; mountpoint -q ${sq(at)} && umount ${sq(at)} 2>/dev/null; mount -t drvfs ${sq(s.path.replace(/\//g, '\\'))} ${sq(at)} -o ${opt} || echo "could not mount ${s.path}"`);
    }
    const r = await this.wsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-s'], { input: lines.join('\n') + '\n', timeout: 60000 });
    if (/could not mount/.test(r.out)) this.log(r.out.trim());
    return r;
  }

  // Shared folders: add or change one (mode read | ask | full), or remove it.
  async share(winPath, mode = 'read') {
    const full = path.resolve(String(winPath));
    if (!fs.existsSync(full)) throw new Error(`${full} doesn't exist.`);
    const list = this.shares().filter(s => path.resolve(s.path).toLowerCase() !== full.toLowerCase());
    list.push({ path: full, mode: MODES[mode] ? mode : 'read' });
    this.store.saveSettings({ sandboxShares: list });
    await this.mountAll();
    return this.toSandbox(full);
  }
  async unshare(winPath) {
    const full = path.resolve(String(winPath)).toLowerCase();
    const gone = this.shares().find(s => path.resolve(s.path).toLowerCase() === full);
    this.store.saveSettings({ sandboxShares: this.shares().filter(s => s !== gone) });
    if (gone) await this.wsl(['-d', DISTRO, '-u', 'root', '--', 'umount', '/mnt/win/' + safeName(gone.path)], { timeout: 20000 });
  }

  // Which share a Windows path is in (or null).
  shareFor(winPath) {
    const full = path.resolve(String(winPath)).toLowerCase();
    return this.shares().find(s => { const b = path.resolve(s.path).toLowerCase().replace(/[\\/]+$/, ''); return full === b || full.startsWith(b + '\\') || full.startsWith(b + '/'); }) || null;
  }
  toSandbox(winPath) {
    const s = this.shareFor(winPath); if (!s) return null;
    const rest = path.resolve(String(winPath)).slice(path.resolve(s.path).replace(/[\\/]+$/, '').length).replace(/\\/g, '/');
    return '/mnt/win/' + safeName(s.path) + rest;
  }
  // A Linux path inside the sandbox, as Windows sees it.
  static toUNC(p) { if (process.env.ORBIT_SANDBOX_ROOT) return path.join(process.env.ORBIT_SANDBOX_ROOT, String(p)); return '\\\\wsl.localhost\\' + DISTRO + String(p).replace(/\//g, '\\'); }

  // Run a command inside the sandbox as the orbit user.
  async run(command, { cwd, timeout = 120000 } = {}) {
    if (!this.keep) await this.warm();
    this.log('$ ' + command);
    const args = ['-d', DISTRO, '--cd', cwd || '/home/orbit/work', '--', 'bash', '-lc', command];
    const r = await this.wsl(args, { timeout, onData: (d) => d.split(/\r?\n/).filter(Boolean).slice(-3).forEach(l => this.log(l)) });
    return r;
  }

  // The sandbox's own headless Chromium, started once and reused. Returns a CDP endpoint on localhost.
  async browserEndpoint() {
    const url = `http://127.0.0.1:${CDP_PORT}`;
    const alive = async () => { try { const r = await fetch(url + '/json/version', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } };
    if (await alive()) return url;
    if (!this.keep) await this.warm();
    const cmd = `pgrep -f orbit-chrome >/dev/null || { B=$(ls -d /opt/pw/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1); nohup "$B" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=${CDP_PORT} --remote-debugging-address=127.0.0.1 --user-data-dir=/home/orbit/.orbit-chrome --window-size=1366,850 --class=orbit-chrome about:blank >/tmp/orbit-chrome.log 2>&1 & }`;
    await this.wsl(['-d', DISTRO, '--', 'bash', '-lc', cmd], { timeout: 30000 });
    for (let i = 0; i < 40; i++) { if (await alive()) return url; await new Promise(r => setTimeout(r, 250)); }
    throw new Error('The sandbox browser didn\'t start.');
  }

  // Keep the sandbox compact: every task's scratch folder goes when the task ends, and a daily sweep
  // clears caches, old scratch and temp files. Shared folders (the user's real files) are never touched.
  scratchFor(taskId) { return '/home/orbit/work/tmp/' + String(taskId || 'main').replace(/[^\w.-]+/g, '_'); }
  async endTask(taskId) { if (!this.keep) return; await this.wsl(['-d', DISTRO, '--', 'rm', '-rf', this.scratchFor(taskId)], { timeout: 30000 }); }
  async cleanup() {
    if ((await this.status()).state !== 'ready') return null;
    const script = `before=$(df --output=used -B1M / | tail -1)
find /home/orbit/work/tmp -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null
find /tmp -mindepth 1 -mtime +1 -not -name 'orbit-chrome*' -exec rm -rf {} + 2>/dev/null
apt-get clean -q; rm -rf /root/.cache/pip /home/orbit/.cache/pip
sudo -u orbit npm cache clean --force >/dev/null 2>&1
rm -rf /home/orbit/.orbit-chrome/Default/Cache /home/orbit/.orbit-chrome/Default/Code\ Cache
fstrim / 2>/dev/null
after=$(df --output=used -B1M / | tail -1); echo "freed $((before-after)) MB"`;
    const r = await this.wsl(['-d', DISTRO, '-u', 'root', '--', 'bash', '-s'], { input: script, timeout: 5 * 60000 });
    const freed = (r.out.match(/freed (-?\d+) MB/) || [])[1];
    this.store.saveSettings({ sandboxCleanedAt: Date.now() });
    this.log(`cleanup: ${freed != null ? freed + ' MB freed' : r.out.trim().slice(-200)}`);
    return Number(freed) || 0;
  }
  // Run the sweep once a day while Orbit is open (and soon after start if it is overdue).
  scheduleCleanup() {
    clearInterval(this._clean);
    const due = () => { if (this.on && Date.now() - (this.store.getSettings().sandboxCleanedAt || 0) > 23 * 3600e3) this.cleanup().catch(() => {}); };
    setTimeout(due, 5 * 60000); this._clean = setInterval(due, 3600e3);
  }

  async reset() {
    this.stop();
    await this.wsl(['--unregister', DISTRO], { timeout: 120000 });
    try { fs.rmSync(path.join(this.dir, 'disk'), { recursive: true, force: true }); } catch {}
    return this.setup();
  }
}

module.exports = { Sandbox, MODES, DISTRO, safeName, CDP_PORT };
