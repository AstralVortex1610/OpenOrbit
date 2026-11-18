// v0.13.0 auto-update: a failed check retries within minutes (not an hour), a found update is
// downloaded, and every step goes to update.log.
const path = require('path'); const fs = require('fs'); const os = require('os');
const Module = require('module'); const orig = Module._load;
Module._load = function (r, ...a) { if (r === 'electron') return { powerMonitor: { on() {} } }; return orig.call(this, r, ...a); };
const { Updater } = require('../src/updater');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-upd-'));
  const app = { getVersion: () => '0.12.4', getPath: () => dir, isPackaged: true };
  const u = new Updater({ app, send: () => {} });
  let calls = 0; global.fetch = async () => { calls++; throw new Error('fetch failed'); };
  u.auto = true;
  const st = await u.autoStep();
  assert(st._checkFailed === 'fetch failed', 'a failed quiet check is reported, not swallowed');
  const timers = []; const realST = global.setTimeout; global.setTimeout = (fn, ms) => { timers.push(ms); return realST(() => {}, 0); };
  u.startAuto(true); await new Promise(r => realST(r, 5)); await u._run(); global.setTimeout = realST;
  assert(timers.includes(2 * 60 * 1000), 'retries in 2 minutes: ' + timers.join(','));
  assert(/check failed \(fetch failed\), retrying in 2 min/.test(fs.readFileSync(path.join(dir, 'update.log'), 'utf8')), 'logged to update.log');
  clearInterval(u.timer); clearTimeout(u._first); clearTimeout(u._retry);
  global.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v0.13.0-beta', html_url: 'x', body: 'n', assets: [{ name: 'Orbit-0.13.0-win.zip', browser_download_url: 'http://z', size: 3 }] }) });
  u.download = async () => u._set({ status: 'ready' });
  let ready = false; u.onReady = () => { ready = true; };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const s2 = await u.autoStep();
  assert(s2.status === 'ready' && ready, 'found update downloads and waits for idle');
  assert(/found 0\.13\.0-beta/.test(fs.readFileSync(path.join(dir, 'update.log'), 'utf8')), 'found logged');
  console.log('\nall updater checks passed'); process.exit(0);
})();
