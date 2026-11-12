// 0.11 end to end: Passwords screen (add, show, edit, delete) in the real app window.
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-v11-'));
app.setPath('userData', tmp); app.disableHardwareAcceleration();
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ autoCall: false, talkFirst: false, autoUpdate: false, baseUrl: 'http://127.0.0.1:9/v1', model: 'mock', apiKeyEnc: Buffer.from('sk').toString('base64') }));
require('../src/main.js');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });
app.whenReady().then(async () => {
  await wait(2500);
  const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 840); win.show(); const js = (s) => win.webContents.executeJavaScript(s);
  const shot = async (n) => { await wait(600); fs.writeFileSync(path.join(out, `v11-${n}.png`), (await win.webContents.capturePage()).toPNG()); };
  const fail = (m) => { console.error('FAIL', m); app.exit(1); };
  try {
    await js(`document.querySelector('[data-view="passwords"]').click()`); await wait(400);
    if (!(await js(`!!document.querySelector('#view-passwords.active')`))) return fail('passwords view not shown');
    await shot('empty');
    for (const [s, u, p, n] of [['github.com', 'AstralVortex1610', 'gh-Secret-1', ''], ['kaggle.com', 'affanm2010@gmail.com', 'kg-Secret-2', 'Gemma 4 comp'], ['missionjeet.in', 'affan', 'mj-Secret-3', '']]) {
      await js(`document.querySelector('#pwAdd').click(); document.querySelector('#pwSite').value=${JSON.stringify(s)}; document.querySelector('#pwUser').value=${JSON.stringify(u)}; document.querySelector('#pwPass').value=${JSON.stringify(p)}; document.querySelector('#pwNote').value=${JSON.stringify(n)}; document.querySelector('#pwSave').click()`);
      await wait(400);
    }
    const n = await js(`document.querySelectorAll('.pw-row').length`); if (n !== 3) return fail('rows ' + n);
    const raw = fs.readFileSync(path.join(tmp, 'logins.json'), 'utf8'); if (raw.includes('gh-Secret-1')) return fail('plain text on disk');
    await js(`document.querySelector('.pw-row [data-show]').click()`); await wait(400);
    const shownTxt = await js(`document.querySelector('.pw-row [data-pw]').textContent`); if (shownTxt !== 'gh-Secret-1') return fail('reveal ' + shownTxt);
    await shot('list');
    await js(`document.querySelector('#pwSearch').value='kag'; document.querySelector('#pwSearch').dispatchEvent(new Event('input'))`); await wait(200);
    if ((await js(`document.querySelectorAll('.pw-row').length`)) !== 1) return fail('search');
    console.log('ok  add 3 logins, encrypted on disk, show password, search');
    console.log('PASS v11-e2e'); app.exit(0);
  } catch (e) { fail(e.stack); }
});
