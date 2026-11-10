// Records Orbit's real Phonon voice to a WAV. TEXT=... VOICE=Easton OUT=... xvfb-run -a npx electron --no-sandbox test/voice-note.js
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-note-'));
app.setPath('userData', tmp); app.disableHardwareAcceleration();
fs.symlinkSync(process.env.ORBIT_MODELS || '/workspace/work/models', path.join(tmp, 'models'));
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ liveEngine: 'orbit', orbitTts: 'phonon', autoCall: false, closeToTray: false }));
require('../src/main.js');
app.whenReady().then(() => setTimeout(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const pcm = await win.webContents.executeJavaScript(`(async () => {
    while (!window.OrbitVoice) await new Promise(r => setTimeout(r, 100));
    await OrbitVoice.ensure(); OrbitVoice.setPhononVoice(${JSON.stringify(process.env.VOICE || 'Easton')});
    const chunks = []; let last = Date.now();
    OrbitVoice.onVoice(m => { if (m.type === 'audio') { chunks.push(Array.from(m.pcm)); last = Date.now(); } });
    OrbitVoice.speak(${JSON.stringify(process.env.TEXT)});
    while (!chunks.length || Date.now() - last < 6000) await new Promise(r => setTimeout(r, 300));
    return chunks.flat();
  })()`);
  const n = pcm.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  pcm.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
  fs.writeFileSync(process.env.OUT, b); console.log('WROTE', (n / 24000).toFixed(1) + 's'); app.exit(0);
}, 500));
setTimeout(() => { console.log('FAIL timeout'); app.exit(2); }, 115000);
