// Feeds synthesized speech through Orbit's wake-word recognizer inside Electron.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs'); const path = require('path');
function wavToFloat(file) {
  const b = fs.readFileSync(file); const rate = b.readUInt32LE(24); let off = 12;
  while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
  const n = b.readUInt32LE(off + 4) / 2; const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
  return { rate, samples: out };
}
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  ipcMain.handle('wake:model', () => fs.readFileSync(path.join(__dirname, '../../assets/vosk-model-small-en-us-0.15.tar.gz')));
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  w.webContents.on('console-message', (_e, l, m) => { if (!/LOG/.test(m)) console.log('page:', m.slice(0, 200)); });
  await w.loadFile(path.join(__dirname, 'page.html'));
  console.log('loaded page');
  const t0 = Date.now();
  console.log('model:', await w.webContents.executeJavaScript(`(async()=>{ try { await OrbitWake.recognizeSamples(new Float32Array(16000), 16000); return 'ok'; } catch(e) { return 'ERR ' + e; } })()`), Date.now() - t0, 'ms');
  const fails = [];
  const files = fs.readdirSync('/tmp').filter(f => /^(pos|neg)\d+\.wav$/.test(f)).sort();
  const grammars = { shipped: undefined };
  for (const [g, gram] of Object.entries(grammars)) {
    console.log('== ' + g);
    for (const f of files) {
      const { rate, samples } = wavToFloat('/tmp/' + f);
      const r = await w.webContents.executeJavaScript(`OrbitWake.recognizeSamples(new Float32Array(${JSON.stringify(samples.map(x => +x.toFixed(4)))}), ${rate}, ${JSON.stringify(gram)})`);
      console.log(f, r.wake ? 'WAKE' : '-', '|', r.words); (/^pos/.test(f) ? (r.wake ? 0 : fails.push(f)) : (r.wake && f !== 'neg4.wav' ? fails.push(f) : 0));
    }
  }
  console.log(fails.length ? 'WAKE FAIL ' + fails : 'WAKE PASS (neg4 is "hey or bit", allowed)');
  app.quit();
});
