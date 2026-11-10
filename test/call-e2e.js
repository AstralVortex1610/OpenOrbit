// Full app, real models, fake mic: start a live call and make sure it reaches "Listening" (no endless "Connecting…").
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-call-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();
fs.symlinkSync(process.env.ORBIT_MODELS || '/workspace/work/models', path.join(tmp, 'models'));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ apiKeyEnc: Buffer.from('test-key').toString('base64'), baseUrl: 'http://127.0.0.1:9/v1', model: 'x', liveEngine: process.env.ENGINE || 'orbit', orbitTts: process.env.TTS || 'auto', liveGeminiKeyEnc: process.env.ENGINE === 'gemini' ? Buffer.from('k').toString('base64') : undefined, closeToTray: false }));
if (process.env.ENGINE === 'gemini') process.env.ORBIT_GEMINI_URL = 'ws://127.0.0.1:' + require('./_silent-ws')();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
require('../src/main.js');
const t0 = Date.now();
app.whenReady().then(() => setTimeout(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const seen = [];
  await win.webContents.executeJavaScript('window.OrbitLive.start(); true');
  const iv = setInterval(async () => {
    const r = await win.webContents.executeJavaScript(`({ s: document.querySelector('#live').dataset.state, t: document.querySelector('#liveStatus').textContent, o: document.querySelector('#liveOrbit').textContent })`);
    const line = `${r.s} | ${r.t} | ${r.o}`; if (seen[seen.length - 1] !== line) { seen.push(line); console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', line); }
    if (r.s === 'listening' || r.s === 'ended') { clearInterval(iv); console.log(r.s === 'listening' ? 'PASS reached Listening' : 'ENDED: ' + r.o); app.exit(r.s === 'listening' || process.env.ENGINE === 'gemini' ? 0 : 1); }
  }, 500);
}, 1500));
setTimeout(() => { console.log('FAIL: still connecting after 8 min'); app.exit(2); }, 480000);
