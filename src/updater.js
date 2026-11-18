// Orbit — in-app updates from GitHub Releases.
// Checks the latest release, downloads its Windows zip, then a small PowerShell
// script waits for Orbit to close, copies the new files over this install and
// reopens it. Settings, chats, memory and tasks live in userData, so nothing resets.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'AstralVortex1610/OpenOrbit';
// Electron's own network stack (system proxy, Windows certificates). Plain Node fetch failed on some
// PCs with "fetch failed", which silently stopped every automatic check.
function netFetch(url, opts) {
  try { const { net } = require('electron'); if (net && typeof net.fetch === 'function') return net.fetch(url, opts).catch(() => fetch(url, opts)); } catch {}
  return fetch(url, opts);
}

function parse(v) { return String(v || '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0); }
function newer(a, b) { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
function applyScript(o) {
  return [
      '$ErrorActionPreference = "Continue"',
      `$zip = ${q(o.zip)}; $tmp = ${q(o.tmp)}; $dest = ${q(o.dest)}; $exe = ${q(o.exe)}; $log = ${q(o.log)}; $want = ${q(o.want)}`,
      '$root = $dest.TrimEnd([char]92) + [char]92',
      'function Log($m) { "$(Get-Date -Format o) $m" | Add-Content -Path $log -Encoding UTF8 }',
      `Log "update to $want starting (pid ${o.pid}, folder $dest)"`,
      `$flag = ${q(o.flag)}; Set-Content -Path $flag -Value $PID`,
      `Wait-Process -Id ${o.pid} -Timeout 20 -ErrorAction SilentlyContinue`,
      // anything still running from this folder (Orbit itself, its helpers) is stopped so files unlock
      'for ($i = 0; $i -lt 10; $i++) {',
      '  $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })',
      '  if ($left.Count -eq 0) { break }',
      '  if ($i -eq 0) { Log "waiting for $($left.Count) Orbit process(es) to close" }',
      '  if ($i -ge 2) { $left | Stop-Process -Force -ErrorAction SilentlyContinue }',
      '  Start-Sleep -Milliseconds 800',
      '}',
      'Start-Sleep -Milliseconds 700',
      'Unblock-File -Path $zip -ErrorAction SilentlyContinue',
      'New-Item -ItemType Directory -Force -Path $tmp | Out-Null',
      '& tar.exe -xf $zip -C $tmp 2>$null',
      'if (-not (Get-ChildItem $tmp -Recurse -Filter $exe -ErrorAction SilentlyContinue)) { Log "tar could not unpack, trying Expand-Archive"; Expand-Archive -Path $zip -DestinationPath $tmp -Force }',
      '$src = (Get-ChildItem $tmp -Recurse -Filter $exe | Select-Object -First 1).DirectoryName',
      '$ok = $false',
      'if ($src) {',
      '  $newAsar = Join-Path $src "resources\\app.asar"',
      '  for ($i = 0; $i -lt 6; $i++) {',
      '    & robocopy $src $dest /E /IS /IT /R:2 /W:1 /NP /NDL /NJH /NJS "/LOG+:$log" | Out-Null',
      '    $rc = $LASTEXITCODE',
      '    $same = (Test-Path $newAsar) -and ((Get-FileHash $newAsar).Hash -eq (Get-FileHash (Join-Path $dest "resources\\app.asar") -ErrorAction SilentlyContinue).Hash)',
      '    if ($rc -lt 8 -and $same) { $ok = $true; break }',
      '    Log "copy attempt $($i + 1) not complete (robocopy $rc), retrying"',
      '    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue',
      '    Start-Sleep 2',
      '  }',
      '  if ($ok) { Log "updated to $want" } else { Log "UPDATE FAILED: files in $dest stayed locked or unwritable" }',
      '} else { Log "UPDATE FAILED: no $exe in the downloaded zip" }',
      'Remove-Item $flag -Force -ErrorAction SilentlyContinue',
      o.relaunch === false ? 'Log "Orbit was closing, so it was not reopened"' : 'Start-Process -FilePath (Join-Path $dest $exe) -WorkingDirectory $dest',
      'Start-Sleep 5; Remove-Item -Recurse -Force (Split-Path $zip) -ErrorAction SilentlyContinue',
    ].join('\r\n');
}

const applyingFlag = (app) => path.join(app.getPath('userData'), 'update-applying');
// True while the update script is copying files: a copy of Orbit opened by hand now would lock
// them, so it should step aside and let the script reopen the new version.
function updateInProgress(app) {
  try {
    const f = applyingFlag(app); const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > 3 * 60 * 1000) return false;
    const pid = parseInt(fs.readFileSync(f, 'utf8'), 10);
    if (pid) process.kill(pid, 0); // throws if the script is gone
    return true;
  } catch { return false; }
}

class Updater {
  constructor({ app, send }) {
    this.app = app; this.send = send;
    this.state = { status: 'idle', current: app.getVersion() };
    this.timer = null;
    this._verify();
  }

  // After "Update now", the next launch checks it is really the new version.
  _verify() {
    let pend; const f = path.join(this.app.getPath('userData'), 'update-pending.json');
    try { pend = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return; }
    try { fs.unlinkSync(f); } catch {}
    if (!pend || !pend.want) return;
    if (newer(pend.want, this.state.current)) {
      let tail = ''; try { tail = fs.readFileSync(path.join(this.app.getPath('userData'), 'update.log'), 'utf8').split(/\r?\n/).filter(l => /UPDATE FAILED|not complete|starting|updated to/.test(l)).slice(-3).join(' · '); } catch {}
      this.state = { ...this.state, status: 'error', error: `The update to ${pend.want} didn't install, so you're still on ${this.state.current}. ${tail ? 'Log: ' + tail.slice(0, 300) : 'The update script never ran (antivirus or PowerShell may have blocked it).'} Try again, or download the zip from GitHub.`, lastFailure: true };
      this.state.lastFailure = this.state.error;
    } else this.state = { ...this.state, status: 'updated', justUpdated: pend.from };
  }
  _log(m) { try { fs.appendFileSync(path.join(this.app.getPath('userData'), 'update.log'), `${new Date().toISOString()} [auto] ${m}\r\n`); } catch {} }
  _set(patch) { this.state = { ...this.state, ...patch }; this.send('update:state', this.state); return this.state; }

  // Automatic updates: check soon after launch and every hour; when a new version is out,
  // download it in the background, then install it the moment Orbit is idle (or when it quits).
  startAuto(enabled) {
    clearInterval(this.timer); this.timer = null; clearTimeout(this._first);
    this.auto = !!enabled;
    if (!enabled) return;
    // A failed check retries soon (2, 5, 15, 30 min) instead of waiting a whole hour; then hourly.
    const backoff = [2, 5, 15, 30].map(m => m * 60 * 1000); let fails = 0;
    const run = async () => {
      clearTimeout(this._retry);
      let st; try { st = await this.autoStep(); } catch (e) { st = { status: 'error', error: e.message }; }
      if (this.auto && st && st._checkFailed) { const wait = backoff[Math.min(fails++, backoff.length - 1)]; this._log(`check failed (${st._checkFailed}), retrying in ${wait / 60000} min`); this._retry = setTimeout(run, wait); }
      else fails = 0;
    };
    this._run = run;
    this._first = setTimeout(run, 10000);
    this.timer = setInterval(run, 60 * 60 * 1000);
    if (!this._resumeHooked) { this._resumeHooked = true; try { require('electron').powerMonitor.on('resume', () => { if (this.auto) setTimeout(() => this._run && this._run(), 15000); }); } catch {} }
  }
  async autoStep() {
    if (!this.auto || ['downloading', 'installing', 'ready'].includes(this.state.status)) return this.state;
    const st = await this.check(true);
    if (st._checkFailed) return st;
    if (st.status === 'available') this._log(`found ${st.latest} (on ${this.state.current})`);
    if (st.status === 'available' && process.platform === 'win32' && this.app.isPackaged) {
      const d = await this.download(true);
      this._log(d.status === 'ready' ? `downloaded ${st.latest}, installs when idle` : `download failed: ${d.error}`);
      if (d.status !== 'ready') return { ...this.state, _checkFailed: d.error || 'download failed' };
    }
    if (this.state.status === 'ready' && this.onReady) this.onReady(this.state);
    return this.state;
  }

  async check(quiet) {
    if (this.state.status === 'downloading' || this.state.status === 'installing') return this.state;
    if (!quiet) this._set({ status: 'checking', error: '' });
    try {
      const r = await netFetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Orbit-Updater' } });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const rel = await r.json();
      const asset = (rel.assets || []).find(a => /win\.zip$/i.test(a.name));
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      if (!asset || !newer(latest, this.state.current)) return this._set({ status: 'latest', latest, checkedAt: Date.now(), error: '' });
      return this._set({ status: 'available', latest, notes: String(rel.body || '').slice(0, 1500), url: asset.browser_download_url, size: asset.size, page: rel.html_url, checkedAt: Date.now(), error: '' });
    } catch (e) {
      if (quiet) return { ...this.state, _checkFailed: e.message };
      return this._set({ status: 'error', error: `Couldn't check for updates: ${e.message}` });
    }
  }

  async install() {
    if (this.state.status === 'ready' && this._zip && fs.existsSync(this._zip.zip)) return this.apply();
    if (this.state.status !== 'available' && this.state.status !== 'error') await this.check();
    if (!this.state.url) return this.state;
    const got = await this.download(false);
    if (got.status !== 'ready') return got;
    return this.apply();
  }

  // Fetch the new zip into a temp folder. quiet: a background download that only shows when done.
  async download(quiet) {
    if (process.platform !== 'win32' || !this.app.isPackaged) return this._set({ status: 'error', error: 'Updates install only in the packaged Windows app.' });
    const dest = path.dirname(process.execPath);
    try { fs.accessSync(dest, fs.constants.W_OK); } catch { return this._set({ status: 'error', error: `Orbit can't write to ${dest}. Move the Orbit folder somewhere like Documents, or download the new zip from GitHub.` }); }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-update-'));
    const zip = path.join(work, 'Orbit.zip');
    this._set({ status: 'downloading', progress: 0, error: '', background: !!quiet });
    try {
      const r = await netFetch(this.state.url, { headers: { 'User-Agent': 'Orbit-Updater' }, redirect: 'follow' });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const total = Number(r.headers.get('content-length')) || this.state.size || 0;
      const out = fs.createWriteStream(zip);
      let got = 0, lastPct = -1;
      for await (let chunk of r.body) {
        chunk = Buffer.from(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; this._set({ progress: pct }); }
      }
      await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
      if (total && got < total) throw new Error('download was cut short');
    } catch (e) {
      return this._set({ status: quiet ? 'available' : 'error', error: `Update download failed: ${e.message}` });
    }
    this._zip = { zip, work, dest };
    return this._set({ status: 'ready', progress: 100 });
  }

  // Swap the files: a PowerShell script waits for Orbit to exit, copies the new build over it and reopens it.
  // relaunch=false is used when Orbit is quitting anyway.
  apply({ relaunch = true } = {}) {
    if (!this._zip || !fs.existsSync(this._zip.zip)) return this._set({ status: 'error', error: 'The downloaded update is missing. Check again.' });
    const { zip, work, dest } = this._zip;
    const exe = path.basename(process.execPath);
    const ps = path.join(work, 'apply.ps1');
    const log = path.join(this.app.getPath('userData'), 'update.log');
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    // The script: wait for Orbit to exit (force it after 20 s), unpack, copy over this folder,
    // check the copy really landed, then reopen. Everything goes to update.log.
    fs.writeFileSync(ps, applyScript({ zip, tmp: path.join(work, 'x'), dest, exe, log, want: this.state.latest, pid: process.pid, flag: applyingFlag(this.app), relaunch }), 'utf8');
    // remember what we expect, so the next launch can tell if the update really landed
    try { fs.writeFileSync(path.join(this.app.getPath('userData'), 'update-pending.json'), JSON.stringify({ want: this.state.latest, from: this.state.current, at: Date.now() })); } catch {}
    this._set({ status: 'installing', progress: 100 }); this._log(`installing ${this.state.latest}`);
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps], { detached: true, stdio: 'ignore', windowsHide: true, cwd: work });
    child.unref();
    this._zip = null;
    if (relaunch) setTimeout(() => { this.onQuit && this.onQuit(); }, 800);
    return this.state;
  }
}

module.exports = { Updater, newer, applyScript, updateInProgress };
