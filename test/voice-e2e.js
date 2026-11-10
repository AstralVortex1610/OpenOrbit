// Real models, real pipeline (in Electron): Kokoro speaks a sentence, Silero VAD + Moonshine hear it back.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { VoiceCache } = require('../src/voice-cache');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.disableHardwareAcceleration();
const page = path.join(__dirname, '..', 'renderer', '_voice-test.html');
fs.writeFileSync(page, `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob: http://127.0.0.1:*; worker-src 'self' blob: http://127.0.0.1:*; connect-src 'self' blob: data: http://127.0.0.1:*;"><script src="voice/voice.js"></script><script src="../test/voice-e2e-page.js"></script>`);
const cacheDir = process.env.ORBIT_MODELS || path.join(os.homedir(), '.orbit-test-models');
const cache = new VoiceCache(cacheDir, (p) => { if (p.done) console.log('downloaded', p.file, Math.round(p.total / 1e6) + 'MB'); });
ipcMain.handle('voice:base', () => cache.start());
ipcMain.handle('settings:get', () => ({ orbitVoice: 'af_heart', orbitStt: process.env.STT || 'moonshine', orbitTts: process.env.TTS || 'kokoro' }));
ipcMain.on('result', (_e, r) => { console.log(JSON.stringify(r, null, 1)); fs.rmSync(page, { force: true }); app.exit(r.ok ? 0 : 1); });
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, preload: path.join(__dirname, 'voice-e2e-preload.js'), contextIsolation: true } });
  win.webContents.on('console-message', (_e, _l, msg) => { if (!/progress/.test(msg)) console.log('[page]', msg.slice(0, 300)); });
  win.loadFile(page);
  setTimeout(() => { console.log('TIMEOUT'); app.exit(2); }, 600000);
});
