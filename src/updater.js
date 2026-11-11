// Orbit — in-app updates from GitHub Releases.
// Checks the latest release, downloads its Windows zip, then a small PowerShell
// script waits for Orbit to close, copies the new files over this install and
// reopens it. Settings, chats, memory and tasks live in userData, so nothing resets.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'AstralVortex1610/OpenOrbit';

function parse(v) { return String(v || '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0); }
function newer(a, b) { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }

class Updater {
  constructor({ app, send }) {
    this.app = app; this.send = send;
    this.state = { status: 'idle', current: app.getVersion() };
    this.timer = null;
  }
  _set(patch) { this.state = { ...this.state, ...patch }; this.send('update:state', this.state); return this.state; }

  startAuto(enabled) {
    clearInterval(this.timer); this.timer = null;
    if (!enabled) return;
    setTimeout(() => this.check(true).catch(() => {}), 15000);
    this.timer = setInterval(() => this.check(true).catch(() => {}), 6 * 60 * 60 * 1000);
  }

  async check(quiet) {
    if (this.state.status === 'downloading' || this.state.status === 'installing') return this.state;
    if (!quiet) this._set({ status: 'checking', error: '' });
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Orbit-Updater' } });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const rel = await r.json();
      const asset = (rel.assets || []).find(a => /win\.zip$/i.test(a.name));
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      if (!asset || !newer(latest, this.state.current)) return this._set({ status: 'latest', latest, checkedAt: Date.now(), error: '' });
      return this._set({ status: 'available', latest, notes: String(rel.body || '').slice(0, 1500), url: asset.browser_download_url, size: asset.size, page: rel.html_url, checkedAt: Date.now(), error: '' });
    } catch (e) {
      if (quiet) return this.state;
      return this._set({ status: 'error', error: `Couldn't check for updates: ${e.message}` });
    }
  }

  async install() {
    if (this.state.status !== 'available' && this.state.status !== 'error') await this.check();
    if (!this.state.url) return this.state;
    if (process.platform !== 'win32' || !this.app.isPackaged) return this._set({ status: 'error', error: 'Updates install only in the packaged Windows app.' });
    const dest = path.dirname(process.execPath);
    try { fs.accessSync(dest, fs.constants.W_OK); } catch { return this._set({ status: 'error', error: `Orbit can't write to ${dest}. Move the Orbit folder somewhere like Documents, or download the new zip from GitHub.` }); }

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-update-'));
    const zip = path.join(work, 'Orbit.zip');
    this._set({ status: 'downloading', progress: 0, error: '' });
    try {
      const r = await fetch(this.state.url, { headers: { 'User-Agent': 'Orbit-Updater' }, redirect: 'follow' });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const total = Number(r.headers.get('content-length')) || this.state.size || 0;
      const out = fs.createWriteStream(zip);
      let got = 0, lastPct = -1;
      for await (const chunk of r.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; this._set({ progress: pct }); }
      }
      await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
      if (total && got < total) throw new Error('download was cut short');
    } catch (e) {
      return this._set({ status: 'error', error: `Update download failed: ${e.message}` });
    }

    const exe = path.basename(process.execPath);
    const ps = path.join(work, 'apply.ps1');
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    fs.writeFileSync(ps, [
      '$ErrorActionPreference = "Continue"',
      `$zip = ${q(zip)}; $tmp = ${q(path.join(work, 'x'))}; $dest = ${q(dest)}; $exe = ${q(exe)}; $log = ${q(path.join(this.app.getPath('userData'), 'update.log'))}`,
      `Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
      'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dest) } | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue',
      'New-Item -ItemType Directory -Force -Path $tmp | Out-Null',
      '& tar.exe -xf $zip -C $tmp 2>$null',
      'if (-not (Get-ChildItem $tmp -Recurse -Filter $exe -ErrorAction SilentlyContinue)) { Expand-Archive -Path $zip -DestinationPath $tmp -Force }',
      '$src = (Get-ChildItem $tmp -Recurse -Filter $exe | Select-Object -First 1).DirectoryName',
      'if ($src) {',
      '  for ($i = 0; $i -lt 5; $i++) { & robocopy $src $dest /E /R:3 /W:1 /NFL /NDL /NJH /NJS | Out-Null; if ($LASTEXITCODE -lt 8) { break }; Start-Sleep 2 }',
      '  "$(Get-Date -Format o) updated from $src (robocopy $LASTEXITCODE)" | Add-Content $log',
      '} else { "$(Get-Date -Format o) update failed: no $exe in the zip" | Add-Content $log }',
      'Start-Process (Join-Path $dest $exe)',
      'Start-Sleep 5; Remove-Item -Recurse -Force (Split-Path $zip) -ErrorAction SilentlyContinue',
    ].join('\r\n'));
    this._set({ status: 'installing', progress: 100 });
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    setTimeout(() => { this.onQuit && this.onQuit(); }, 800);
    return this.state;
  }
}

module.exports = { Updater, newer };
