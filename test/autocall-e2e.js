// Full app, real models, fake mic, NO brain: Orbit opens a call by itself, speaks first with real audio,
// and the call reaches Listening. Run: xvfb-run -a npx electron --no-sandbox test/autocall-e2e.js
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-auto-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();
fs.symlinkSync(process.env.ORBIT_MODELS || '/workspace/work/models', path.join(tmp, 'models'));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ liveEngine: 'orbit', orbitTts: process.env.TTS || 'phonon', userName: 'Affan', closeToTray: false }));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
require('../src/main.js');
const t0 = Date.now();
app.whenReady().then(() => setTimeout(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await win.webContents.executeJavaScript(`window.__audio = 0; window.__said = []; (function hook(){ if (!window.OrbitVoice) return setTimeout(hook, 100); OrbitVoice.onVoice(m => { if (m.type === 'audio') window.__audio += m.pcm.length; }); window.orbit.on('live:event', e => { if (e.type === 'say') window.__said.push(e.text); }); })(); true`);
  const seen = [];
  const iv = setInterval(async () => {
    const r = await win.webContents.executeJavaScript(`({ open: document.querySelector('#live').classList.contains('open'), s: document.querySelector('#live').dataset.state, t: document.querySelector('#liveStatus').textContent, o: document.querySelector('#liveOrbit').textContent, a: window.__audio, said: window.__said })`);
    const line = `${r.open ? 'OPEN' : 'closed'} ${r.s} | ${r.t} | ${r.o.slice(0, 90)} | audio ${(r.a / 24000).toFixed(1)}s`;
    if (seen[seen.length - 1] !== line) { seen.push(line); console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', line); }
    if (r.open && r.a > 24000 && r.said.some(x => /hear me/.test(x))) { clearInterval(iv); console.log('said:', r.said[0]); console.log('PASS opened by itself and spoke first'); app.exit(0); }
    if (r.s === 'ended') { clearInterval(iv); console.log('FAIL ended: ' + r.o); app.exit(1); }
  }, 500);
}, 500));
setTimeout(() => { console.log('FAIL: timeout'); app.exit(2); }, 300000);
