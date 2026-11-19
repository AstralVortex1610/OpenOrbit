// Custom assistant name + Companion view, in the full app with a mock model.
// Run: xvfb-run -a npx electron --no-sandbox test/companion-e2e.js   (screenshots go to dist-extra/screens/)
const { app, BrowserWindow } = require('electron');
const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-cmp-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();

const systems = [];
const REPLY = "Haha, great timing! You've got the **physics mock** at 4 pm and two chapters of organic left. It's 24° in Mysuru, so a walk after is a good idea. Want me to set a 6 pm revision reminder?";
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
    const j = JSON.parse(body); systems.push(j.messages[0].content);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }], usage: { total_tokens: 50 } }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
});

server.listen(0, () => {
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ apiKeyEnc: Buffer.from('k').toString('base64'), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', userName: 'Affan', closeToTray: false, autoCall: false, autoUpdate: false }));
  require('../src/main.js');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const out = process.env.SHOTS || path.join(__dirname, '..', 'dist-extra', 'screens'); fs.mkdirSync(out, { recursive: true });
  const shot = async (win, name) => { fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG()); console.log('shot', name); };
  app.whenReady().then(async () => {
    let failed = false;
    const check = (cond, msg) => { if (!cond) { failed = true; console.log('FAIL:', msg); } else console.log('ok:', msg); };
    try {
      await wait(2500);
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(1280, 800); win.show();
      const js = (s) => win.webContents.executeJavaScript(s);
      const st = await js('orbit.getSettings()');
      check(st.assistantName === 'Orbit' && st.interfaceStyle === 'classic', 'defaults: name Orbit, classic interface');
      check(!(await js("document.body.classList.contains('companion-on')")), 'classic by default');

      // ---- Settings: name field + Interface option, saved through the normal Save button ----
      await js(`document.querySelector('[data-view=settings]').click()`); await wait(700);
      await js(`{ const n=document.querySelector('#s-assistantName'); n.value='   Luna   '; n.dispatchEvent(new Event('input',{bubbles:true})); }`);
      await js(`document.querySelector('#saveSettings').click()`); await wait(900);
      let s2 = await js('orbit.getSettings()');
      check(s2.assistantName === 'Luna', 'name saved trimmed (Luna)');
      await js(`document.querySelector('#s-assistantName').closest('.card').scrollIntoView({block:'center'})`); await wait(400);
      await shot(win, '01-settings-name.png');
      await js(`document.querySelector('#s-interfaceStyle').closest('.card').scrollIntoView({block:'center'})`); await wait(400);
      await shot(win, '02-settings-interface.png');
      // empty -> Orbit, long -> 24 chars
      await js(`orbit.saveSettings({ assistantName: '' })`); check((await js('orbit.getSettings()')).assistantName === 'Orbit', 'empty name falls back to Orbit');
      await js(`orbit.saveSettings({ assistantName: 'A very long assistant name that goes on' })`); check((await js('orbit.getSettings()')).assistantName.length <= 24, 'name capped at 24 chars');
      await js(`orbit.saveSettings({ interfaceStyle: 'bogus' })`); check((await js('orbit.getSettings()')).interfaceStyle === 'classic', 'bad interface value stays classic');
      await js(`document.querySelector('#s-assistantName').value='Luna'; document.querySelector('#saveSettings').click()`); await wait(900);

      // ---- Classic chat with the custom name ----
      await js(`document.querySelector('[data-view=chat]').click()`); await wait(600);
      check(await js(`document.querySelector('#input').placeholder === 'Message Luna…'`), 'composer placeholder uses the name');
      check(await js(`document.querySelector('#homeAskInput').placeholder.startsWith('Ask Luna anything')`), 'home ask placeholder uses the name');
      check(await js(`document.querySelector('.tb-brand').textContent.trim() === 'Luna'`), 'title bar uses the name');
      check(await js(`document.querySelector('#welcome .sub').textContent.startsWith("I'm Luna.")`), 'welcome line uses the name');
      check(await js(`document.title === 'Luna'`), 'window title uses the name');
      check(await js(`document.querySelector('#appInfo').textContent.startsWith('Orbit ')`), 'version line keeps the product name');
      await shot(win, '03-classic-welcome-luna.png');
      await js(`{ const i=document.querySelector('#input'); i.value="What's on my plate today?"; document.querySelector('#composer').requestSubmit() }`);
      await wait(2200);
      check(systems.some(s => /^You are Luna\b/.test(s) && /built on Orbit/.test(s)), 'system prompt says its name is Luna (built on Orbit)');
      check(await js(`getComputedStyle(document.querySelector('.msg.assistant .who')).display === 'none'`), 'classic shows no sender label (unchanged look)');
      await shot(win, '04-classic-chat-luna.png');

      // ---- Companion view ----
      await js(`document.querySelector('[data-view=settings]').click()`); await wait(500);
      await js(`{ const s=document.querySelector('#s-interfaceStyle'); s.value='companion'; s.dispatchEvent(new Event('change',{bubbles:true})) }`); await wait(500);
      check((await js('orbit.getSettings()')).interfaceStyle === 'companion', 'interface style saved on change');
      await js(`document.querySelector('[data-view=chat]').click()`); await wait(900);
      check(await js(`document.body.classList.contains('companion-on')`), 'companion on');
      check(await js(`document.querySelector('.companion .cmp-name').textContent === 'Luna'`), 'avatar label uses the name');
      check(await js(`document.querySelector('.msg.assistant .who').textContent === 'Luna' && getComputedStyle(document.querySelector('.msg.assistant .who')).display !== 'none'`), 'sender label shows in companion');
      check(await js(`[...document.querySelectorAll('.companion .cmp-avatar img')].every(i => i.complete && i.naturalWidth === 436)`), 'all six frames loaded (436 px wide)');
      await js(`OrbitCompanion.debug({ frame: 'neutral', speaking: false })`); await wait(200);
      check(await js(`getComputedStyle(document.querySelector('.companion .cmp-wave')).opacity === '0'`), 'wave pill hidden while idle');
      await shot(win, '05-companion-idle-dark.png');
      await js(`OrbitCompanion.debug({ frame: 'a', speaking: true })`); await wait(400);
      check(await js(`document.querySelector('.companion .cmp-avatar').dataset.frame === 'a'`), 'forced frame a');
      await shot(win, '06-companion-speaking-dark.png');
      await js(`OrbitCompanion.debug(null)`);
      // In a live call the avatar replaces the orb (overlay opened by hand; no mic here).
      await js(`document.querySelector('#live').classList.add('open'); document.querySelector('#liveStatus').textContent='Luna is talking. Jump in anytime.'; OrbitCompanion.debug({ frame: 'o', speaking: true })`); await wait(700);
      check(await js(`getComputedStyle(document.querySelector('#live .orb-wrap')).display === 'none' && getComputedStyle(document.querySelector('#live .cmp-live')).display === 'block'`), 'live call shows the avatar instead of the orb');
      await shot(win, '07-companion-live-call.png');
      await js(`document.querySelector('#live').classList.remove('open'); OrbitCompanion.debug(null)`); await wait(500);
      // A happy reply gets a short laugh once the voice is quiet.
      const laughed = await js(`(async () => { OrbitCompanion.react('Haha, that worked!'); for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 50)); if (OrbitCompanion.frame === 'laugh') return true; } return false; })()`);
      check(laughed, 'joyful reply shows the laugh frame');

      // Real lip sync from an audio node: loud tone -> open mouth + pill, silence -> neutral.
      const lip = await js(`(async () => {
        const ctx = new AudioContext(); await ctx.resume();
        const g = ctx.createGain(); g.connect(ctx.destination); g.gain.value = 0.0001;
        const tap = ctx.createGain(); tap.gain.value = 1;
        const osc = ctx.createOscillator(); osc.frequency.value = 220; const amp = ctx.createGain(); amp.gain.value = 0.5;
        osc.connect(amp); amp.connect(tap); tap.connect(g);
        OrbitCompanion.onAudioNode(tap); osc.start();
        const seen = new Set(); const wait = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 10; i++) { await wait(70); seen.add(OrbitCompanion.frame); }
        const loudSpeaking = OrbitCompanion.speaking;
        amp.gain.value = 0.04; await wait(400); const quiet = OrbitCompanion.frame;
        osc.stop(); await wait(700);
        const after = OrbitCompanion.frame, afterSpeaking = OrbitCompanion.speaking;
        ctx.close();
        return { seen: [...seen], loudSpeaking, quiet, after, afterSpeaking };
      })()`);
      console.log('lip sync:', JSON.stringify(lip));
      check(lip.seen.includes('a') && lip.loudSpeaking, 'loud audio opens the mouth (a) and shows speaking');
      check(['e', 'o', 'neutral'].includes(lip.quiet), 'quieter audio gives a smaller mouth');
      check(['neutral', 'blink', 'laugh'].includes(lip.after) && !lip.afterSpeaking, 'silence returns to idle');

      // speechSynthesis path (no audio access): a hinted speech cycles the mouth.
      const synth = await js(`(async () => { OrbitCompanion.speakingStart(); const seen = new Set(); for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 70)); if (i % 4 === 0) OrbitCompanion.boundary(); seen.add(OrbitCompanion.frame); } const sp = OrbitCompanion.speaking; OrbitCompanion.speakingEnd(); await new Promise(r => setTimeout(r, 200)); return { seen: [...seen], sp, after: OrbitCompanion.speaking }; })()`);
      console.log('synth cycle:', JSON.stringify(synth));
      check(synth.sp && synth.seen.filter(f => ['a', 'o', 'e'].includes(f)).length >= 2 && !synth.after, 'Windows-voice path cycles mouth frames while speaking');

      // Blinks happen on their own.
      const blinked = await js(`(async () => { for (let i = 0; i < 110; i++) { await new Promise(r => setTimeout(r, 60)); if (OrbitCompanion.frame === 'blink') return true; } return false; })()`);
      check(blinked, 'idle blink within ~6.5 s');

      // Light theme
      await js(`document.querySelector('[data-view=settings]').click()`); await wait(300);
      await js(`document.querySelector('#themePick [data-theme=light]').click()`); await wait(300);
      await js(`document.querySelector('[data-view=chat]').click()`); await wait(900);
      await js(`OrbitCompanion.debug({ frame: 'neutral', speaking: false })`); await wait(200);
      await shot(win, '08-companion-idle-light.png');
      await js(`OrbitCompanion.debug({ frame: 'o', speaking: true })`); await wait(400);
      await shot(win, '09-companion-speaking-light.png');
      await js(`OrbitCompanion.debug(null)`);
      // Narrow window
      win.setSize(900, 600); await wait(700);
      await js(`OrbitCompanion.debug({ frame: 'e', speaking: true })`); await wait(400);
      await shot(win, '10-companion-narrow-light.png');
      await js(`OrbitCompanion.debug(null)`);
      win.setSize(1280, 800); await wait(300);
      // Back to classic: the companion disappears completely.
      await js(`document.querySelector('[data-view=settings]').click()`); await wait(300);
      await js(`document.querySelector('#themePick [data-theme=dark]').click()`);
      await js(`{ const s=document.querySelector('#s-interfaceStyle'); s.value='classic'; s.dispatchEvent(new Event('change',{bubbles:true})) }`); await wait(300);
      await js(`document.querySelector('[data-view=chat]').click()`); await wait(700);
      check(await js(`!document.body.classList.contains('companion-on') && getComputedStyle(document.querySelector('#companion')).display === 'none' && getComputedStyle(document.querySelector('#view-chat')).paddingLeft === '0px'`), 'classic restores the original layout');
      await shot(win, '11-classic-again-dark.png');
    } catch (e) { failed = true; console.log('ERROR', e && e.stack || e); }
    console.log(failed ? 'FAIL' : 'PASS'); app.exit(failed ? 1 : 0);
  });
});
