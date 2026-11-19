// Orbit Remote phone UI smoke test: the built phone bundle (remote/build.js) in Chromium with a phone-sized
// viewport, against a real headless Orbit with Phone Link on. Pairs through the UI, chats, opens Orbiter,
// Settings and the Computer view, then kills the laptop and checks the "Laptop offline" banner.
//   node test/remote-ui-smoke.js      (needs Chromium: CHROMIUM=/usr/bin/chromium; SHOTS=dir for screenshots)
const { spawn, execFileSync } = require('child_process');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { chromium } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS || path.join(ROOT, 'dist-remote', 'screens');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0; const check = (c, m) => { if (c) { passed++; console.log('ok:', m); } else { failed++; console.log('FAIL:', m); } };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const www = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-www-'));
  execFileSync(process.execPath, [path.join(ROOT, 'remote', 'build.js'), www], { stdio: 'inherit' });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
  const web = http.createServer((req, res) => { const f = path.join(www, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!f.startsWith(www) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const out = path.join(os.tmpdir(), `orbit-host-${process.pid}.json`); try { fs.unlinkSync(out); } catch {}
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-host-data-'));
  const startHost = (pair) => spawn('xvfb-run', ['-a', path.join(ROOT, 'node_modules', '.bin', 'electron'), '--no-sandbox', path.join(__dirname, '_link-host.js')], { cwd: ROOT, detached: true, env: { ...process.env, HOST_OUT: out, HOST_DATA: data, HOST_PAIR: pair ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const killHost = (h) => { try { process.kill(-h.pid, 'SIGKILL'); } catch {} };
  let host = startHost(true);
  host.stdout.on('data', d => process.env.DEBUG && process.stdout.write('[host] ' + d));
  let info = null; for (let i = 0; i < 120 && !info; i++) { await wait(500); try { info = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {} }
  check(info && info.link, 'headless Orbit up with a pairing code');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${web.address().port}/index.html`);
  await page.waitForSelector('#rmGate', { timeout: 10000 });
  check(await page.isVisible('#rgScan'), 'pairing screen shows on first start');
  check(!(await page.$('.companion')) && !(await page.$('#cmpTalk')), 'no Companion view in the phone UI');
  await page.screenshot({ path: path.join(SHOTS, 'phone-1-pair.png') });
  await page.click('.rg-adv summary'); await page.fill('#rgLink', info.link); await page.click('#rgLinkGo');
  await wait(2500); if (process.env.DEBUG) console.log('pair msg:', await page.textContent('#rgMsg').catch(() => '(reloaded)'), errors);
  await page.waitForLoadState('load'); await wait(1500);
  await page.waitForSelector('#rmChip.on', { timeout: 20000 }).catch(() => {});
  check(await page.isVisible('#rmChip.on'), 'paired and connected (chip shows the laptop)');
  const name = await page.textContent('.tb-brand');
  check(/Nova/.test(name), `custom assistant name from the laptop in the title (${name.trim()})`);
  // chat
  await page.click('.rail-btn[data-view=chat]'); await wait(400);
  check((await page.getAttribute('#input', 'placeholder')) === 'Message Nova…', 'composer uses the assistant name');
  await page.fill('#input', 'Plan my week'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Send the PR to Affan/i.test(document.querySelector('#messages')?.innerText || ''), null, { timeout: 20000 }).catch(() => {});
  const txt = await page.innerText('#messages').catch(() => '');
  check(/send the PR to Affan/i.test(txt), 'chat reply streamed into the phone UI');
  await wait(800);
  await page.screenshot({ path: path.join(SHOTS, 'phone-2-chat.png') });
  // edit button is visible on phone
  check(await page.$('.msg.user .u-edit') !== null, 'message edit available');
  // projects, orbiter, settings
  await page.click('.rail-btn[data-view=projects]'); await wait(600);
  check(await page.isVisible('#view-projects'), 'projects view');
  await page.evaluate(() => document.querySelector('.rail-btn[data-view=orbiter]').click()); await wait(2500);
  const orbFrame = page.frames().find(f => /orbiter\.html/.test(f.url()));
  const orbOk = orbFrame ? await orbFrame.evaluate(() => !!window.orbiter && document.body.innerText.length > 20).catch(() => false) : false;
  check(orbOk, 'Orbiter (coding agent) loads on the phone through the frame bridge');
  await page.screenshot({ path: path.join(SHOTS, 'phone-3-orbiter.png') });
  await page.evaluate(() => document.querySelector('.rail-btn[data-view=settings]').click()); await wait(900);
  check(await page.isVisible('#rmCard'), '"This phone" card in Settings');
  check(!(await page.isVisible('#plCard')), 'Phone Link management is not on the phone');
  const sv = await page.evaluate(() => orbit.getSettings()); check(!sv.apiKey && sv.hasKey, 'no API key on the phone');
  await page.screenshot({ path: path.join(SHOTS, 'phone-4-settings.png') });
  const tiers = await page.evaluate(() => orbit.models.choices().then(x => !!x)); check(tiers, 'model tier choices load');
  // file download (a file the laptop made)
  const fp = path.join(info.data, 'workspace', 'report.txt'); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, 'report from the laptop');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.evaluate((p) => orbit.files.open(p), fp)]);
  check(dl && dl.suggestedFilename() === 'report.txt', 'a laptop file downloads to the phone');
  // offline: the laptop goes away
  await page.click('.rail-btn[data-view=chat]'); await wait(300);
  killHost(host);
  await page.waitForSelector('#rmBanner.show.off', { timeout: 30000 }).catch(() => {});
  check(await page.isVisible('#rmBanner.show.off'), '"Laptop offline" banner when the laptop is gone');
  await page.fill('#input', 'Are you there?'); await page.keyboard.press('Enter'); await wait(800);
  check(/waiting/.test(await page.innerText('#rmBanner')), 'message waits in the queue while offline');
  await page.screenshot({ path: path.join(SHOTS, 'phone-5-offline.png') });
  // the laptop comes back (same data dir, same pairing): the queued message goes through
  host = startHost(false);
  await page.waitForSelector('#rmChip.on', { timeout: 40000 }).catch(() => {});
  check(await page.isVisible('#rmChip.on'), 'reconnects by itself when the laptop is back');
  await page.waitForFunction(() => /up to date/i.test(document.querySelector('#messages')?.innerText || ''), null, { timeout: 20000 }).catch(() => {});
  check(/up to date/i.test(await page.innerText('#messages').catch(() => '')), 'queued message answered after reconnect');
  const real = errors.filter(e => !/favicon|ERR_CONNECTION_REFUSED|WebSocket|net::/.test(e));
  check(!real.length, `no page errors${real.length ? ': ' + real.slice(0, 3).join(' | ') : ''}`);
  await browser.close(); killHost(host); web.close();
  console.log(failed ? `remote-ui-smoke: ${failed} FAILED, ${passed} passed` : `remote-ui-smoke: all ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
