// Updater: version compare, and the next-launch check that an update really landed.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Updater, newer } = require('../src/updater');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
assert(newer('0.10.1-beta', '0.10.0') && !newer('0.10.0', '0.10.0') && newer('0.10.0', '0.9.1'), 'version compare (0.10 > 0.9)');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-upd-'));
const app = (v) => ({ getVersion: () => v, getPath: () => dir, isPackaged: true });
const sent = [];
fs.writeFileSync(path.join(dir, 'update-pending.json'), JSON.stringify({ want: '0.10.1', from: '0.10.0' }));
fs.writeFileSync(path.join(dir, 'update.log'), '2026-11-12 update to 0.10.1 starting\n2026-11-12 UPDATE FAILED: files in C:\\Orbit stayed locked or unwritable\n');
let u = new Updater({ app: app('0.10.0'), send: (c, s) => sent.push(s) });
assert(u.state.status === 'error' && /didn't install/.test(u.state.error) && /stayed locked/.test(u.state.lastFailure), 'failed update is reported on next launch with the log line');
assert(!fs.existsSync(path.join(dir, 'update-pending.json')), 'pending marker cleared');
fs.writeFileSync(path.join(dir, 'update-pending.json'), JSON.stringify({ want: '0.10.1', from: '0.10.0' }));
u = new Updater({ app: app('0.10.1'), send: () => {} });
assert(u.state.status === 'updated' && u.state.justUpdated === '0.10.0', 'successful update is confirmed');
u = new Updater({ app: app('0.10.1'), send: () => {} });
assert(u.state.status === 'idle', 'normal launch untouched');

const { updateInProgress, applyScript } = require('../src/updater');
fs.writeFileSync(path.join(dir, 'update-applying'), String(process.pid));
assert(updateInProgress(app('0.10.0')), 'a copy opened during the update steps aside');
fs.writeFileSync(path.join(dir, 'update-applying'), '999999');
assert(!updateInProgress(app('0.10.0')), 'a stale flag from a dead script is ignored');
const ps = applyScript({ zip: 'z', tmp: 't', dest: 'C:\\Orbit', exe: 'Orbit.exe', log: 'l', want: '0.10.1', pid: 1, flag: 'f' });
assert(/Stop-Process -Force/.test(ps) && /Get-FileHash/.test(ps) && /Remove-Item \$flag/.test(ps) && ps.indexOf('Remove-Item $flag') < ps.indexOf('Start-Process'), 'script force-closes, verifies the copy, clears the flag before reopening');
console.log('PASS updater-test (full)');
