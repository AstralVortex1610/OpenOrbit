// Runs Orbit (main process, headless) with Phone Link on and a mock model, for phone-side tests.
// Writes { link, status } to $HOST_OUT once a pairing code is up. Extra settings: $HOST_SETTINGS (JSON).
//   xvfb-run -a npx electron --no-sandbox test/_link-host.js
const { app, BrowserWindow } = require('electron');
const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = process.env.HOST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-host-'));
app.setPath('userData', tmp); app.disableHardwareAcceleration();
process.env.ORBIT_TEST_HOOKS = '1';
const model = http.createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
    let j = {}; try { j = JSON.parse(body); } catch {}
    const last = JSON.stringify((j.messages || []).slice(-1)).toLowerCase();
    const reply = /plan|week/.test(last) ? "Here's your week, sorted:\n\n- **Mon**: finish the Orbit Remote build and test pairing\n- **Tue**: physics mock at 4 pm, then a walk\n- **Wed**: send the PR to Affan\n\nWant me to put these on your calendar?"
      : 'Done. I checked it on the laptop: everything is up to date.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const words = reply.split(/(?<= )/); let i = 0;
    const t = setInterval(() => { if (i >= words.length) { clearInterval(t); res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 40 } }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); return; } res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: words[i++] } }] }) + '\n\n'); }, 25);
  });
});
model.listen(0, () => {
  if (!fs.existsSync(path.join(tmp, 'settings.json'))) fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
    apiKeyEnc: Buffer.from('sk-host-test').toString('base64'), baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'gpt-5.1', userName: 'Meher', assistantName: 'Nova',
    closeToTray: false, autoCall: false, autoUpdate: false, talkFirst: false, phoneLinkEnabled: true, phoneLinkRemote: 'off', ...(JSON.parse(process.env.HOST_SETTINGS || '{}')),
  }));
  else { const s = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8')); s.baseUrl = `http://127.0.0.1:${model.address().port}/v1`; fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(s)); }
  require('../src/main.js');
  app.whenReady().then(async () => {
    await new Promise(r => setTimeout(r, 2500));
    const PL = global.__orbit.phoneLink;
    for (let i = 0; i < 120; i++) { const s = PL.status(); if (s.on && (s.mode !== 'cloudflare' || (s.tunnel && s.tunnel.state === 'up'))) break; await new Promise(r => setTimeout(r, 500)); }
    if (process.env.HOST_PAIR !== '0') await PL.startPairing();
    const st = await PL.statusWithQr();
    if (process.env.HOST_OUT) fs.writeFileSync(process.env.HOST_OUT, JSON.stringify({ link: st.pairing && st.pairing.link, code: st.pairing && st.pairing.code, status: st, data: tmp }));
    console.log('HOST READY', st.port);
    if (process.env.HOST_SHOT) {
      const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 860); win.show();
      await win.webContents.executeJavaScript(`document.querySelector('[data-view=settings]').click()`); await new Promise(r => setTimeout(r, 700));
      await win.webContents.executeJavaScript(`document.querySelector('#plCard').scrollIntoView({block:'start'})`); await new Promise(r => setTimeout(r, 700));
      fs.writeFileSync(process.env.HOST_SHOT, (await win.webContents.capturePage()).toPNG());
    }
  });
});
