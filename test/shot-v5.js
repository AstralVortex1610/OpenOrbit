const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 780, show: false, webPreferences: { offscreen: true, preload: path.join(__dirname, 'mock-preload.js'), contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await wait(1500);
  await win.webContents.executeJavaScript('window.__demo5()');
  await wait(1200);
  fs.writeFileSync(path.join(__dirname, 'shot-v5-parallel.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('[data-view=settings]').click()`);
  await wait(900);
  await win.webContents.executeJavaScript(`document.querySelector('#accountsCard').scrollIntoView({block:'start'})`);
  await wait(500);
  fs.writeFileSync(path.join(__dirname, 'shot-v5-accounts.png'), (await win.webContents.capturePage()).toPNG());
  app.quit();
});
