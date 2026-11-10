// Turn-taking on the call screen: a cough doesn't stop Orbit, real talking does, Orbit's own echo is ignored,
// and a sentence that trails off ("and…") waits for the rest.
// Run: xvfb-run -a npx electron --no-sandbox test/barge-test.js
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs');
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const live = html.match(/<div class="live" id="live"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
const page = path.join(__dirname, '..', 'renderer', '_barge-test.html');
fs.writeFileSync(page, `<!doctype html><body>${html.slice(html.indexOf('<div class="live" id="live"'), html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '')}<script src="../test/barge-page.js"></script><script src="live.js"></script></body>`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('[page]', e.message); });
  await win.loadFile(page);
  const js = (s) => win.webContents.executeJavaScript(s);
  const calls = () => js('JSON.stringify(T.calls)').then(JSON.parse);
  const res = {};
  try {
    await js('OrbitLive.start()'); await wait(1500);
    res.state = await js(`document.querySelector('#live').dataset.state`);
    // A: Orbit talking, a cough
    await js(`T.event({ type: 'say', id: 't1', text: 'Your physics mock is tomorrow at four, so revise tonight.' })`); await wait(300);
    await js(`T.ears({ type: 'speech_start', barge: true })`); await wait(100);
    await js(`T.ears({ type: 'speech_cancel' })`); await wait(100);
    res.cough = (await calls()).length === 0;
    // C: echo of its own words
    await js(`T.ears({ type: 'speech_start' }); T.ears({ type: 'transcript', text: 'physics mock is tomorrow at four' })`); await wait(100);
    res.echoIgnored = (await calls()).length === 0;
    // B: real cut-in
    await js(`T.ears({ type: 'speech_start' }); T.ears({ type: 'speech_sustained' })`); await wait(100);
    const c = await calls(); res.cutIn = c.length === 1 && c[0][0] === 'interrupt' && c[0][1].length > 0;
    await js(`T.ears({ type: 'transcript', text: 'wait actually make it physics at six' })`); await wait(100);
    res.turnAfterCut = JSON.stringify((await calls())[1]) === JSON.stringify(['turn', 'wait actually make it physics at six']);
    await js(`T.event({ type: 'say', id: 't2', text: 'Sure, six it is.' })`); await wait(5000); // Orbit answers, then the echo window passes
    // D: trailing "and…" waits, then merges with the rest
    await js(`T.calls.length = 0; T.ears({ type: 'speech_start' }); T.ears({ type: 'transcript', text: 'remind me to study and' })`); await wait(500);
    res.heldCalls = await calls(); res.heldNotSent = res.heldCalls.length === 0;
    await js(`T.ears({ type: 'speech_start' }); T.ears({ type: 'transcript', text: 'call Sam at six.' })`); await wait(200);
    res.merged = JSON.stringify(await calls()) === JSON.stringify([['turn', 'remind me to study and call Sam at six.']]);
    await js(`T.calls.length = 0; T.ears({ type: 'speech_start' }); T.ears({ type: 'transcript', text: 'open chrome and' })`); await wait(1600);
    res.heldTimesOut = JSON.stringify((await calls()).filter(c => c[0] === 'turn')) === JSON.stringify([['turn', 'open chrome and']]);
  } catch (e) { res.error = String(e); }
  fs.rmSync(page, { force: true });
  const ok = ['cough', 'echoIgnored', 'cutIn', 'turnAfterCut', 'heldNotSent', 'merged', 'heldTimesOut'].every(k => res[k]);
  console.log(JSON.stringify(res)); console.log(ok ? 'PASS' : 'FAIL'); app.exit(ok ? 0 : 1);
});
