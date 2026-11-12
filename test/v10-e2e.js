// 0.10 end to end: make_file card in chat, Connectors screen (MCP + API), Osint screen.
// Run: xvfb-run -a npx electron --no-sandbox test/v10-e2e.js   (screens in test/out/v10-*.png)
const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-v10-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-home-')); process.env.HOME = home; process.env.USERPROFILE = home;
app.setPath('userData', tmp); app.disableHardwareAcceleration();
// mock model: 1st turn calls make_file, 2nd turn replies
let calls = 0;
const llm = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[]}'); }
    const j = JSON.parse(body); calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const last = j.messages[j.messages.length - 1];
    if (last.role !== 'tool') {
      const args = JSON.stringify({ format: 'pdf', title: 'Best laptops under 80k for coding', subtitle: 'Three picks, November 2026', kind: 'Comparison', summary: 'Get the **Zenbook 14 OLED**.', content: '## Picks\n\n| Laptop | Price |\n|---|---|\n| Zenbook 14 | ₹77,990 |\n| Yoga Slim 7 | ₹71,490 |\n\n## Why\n- OLED screen\n- 14 h battery', sources: ['https://www.flipkart.com/'] });
      send({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'make_file', arguments: args } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { role: 'assistant', content: 'Your comparison PDF is ready. The **Zenbook 14 OLED** wins on screen and battery.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    }
    res.end('data: [DONE]\n\n');
  });
}).listen(0);
const port = llm.address().port;
fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ autoCall: false, talkFirst: false, autoUpdate: false, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKeyEnc: Buffer.from('sk-test').toString('base64'), osintBeta: true,
  mcpServers: [{ id: 'm1', name: 'Mock Notes', type: 'stdio', command: process.execPath.includes('electron') ? 'node' : process.execPath, args: `"${path.join(__dirname, '_mock-mcp.js')}"`, enabled: true }] }));
require('../src/main.js');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const out = path.join(__dirname, 'out'); fs.mkdirSync(out, { recursive: true });
app.whenReady().then(async () => {
  await wait(2500);
  const win = BrowserWindow.getAllWindows()[0]; win.setSize(1280, 840); win.show(); const js = (s) => win.webContents.executeJavaScript(s);
  const shot = async (n) => { await wait(500); fs.writeFileSync(path.join(out, `v10-${n}.png`), (await win.webContents.capturePage()).toPNG()); };
  const fail = (m) => { console.error('FAIL', m); app.exit(1); };
  try {
    // 1. chat -> make_file -> card
    await js(`document.querySelector('[data-view=chat]').click()`); await wait(400);
    await js(`(() => { const i = document.getElementById('input'); i.value = 'Compare the 3 best laptops under 80k for coding and make me a PDF'; i.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`);
    for (let i = 0; i < 40 && !(await js(`!!document.querySelector('.file-card') && /ready/.test(document.getElementById('messages').textContent)`)); i++) await wait(300);
    const card = await js(`(() => { const c = document.querySelector('.file-card'); return c && c.querySelector('.fc-name').textContent + '|' + c.querySelector('.fc-meta').textContent; })()`);
    if (!card) return fail('no file card');
    const pdf = path.join(home, 'Documents', 'Orbit', 'Best laptops under 80k for coding.pdf');
    if (!fs.existsSync(pdf) || fs.readFileSync(pdf).slice(0, 4).toString() !== '%PDF') return fail('pdf not on disk at ' + pdf);
    console.log('ok  make_file -> PDF on disk + card:', card);
    await shot('chat-file');
    // card survives reopening the chat
    await js(`document.querySelector('[data-view=home]').click()`); await wait(300); await js(`window.OrbitApp.openScope('main')`); await js(`document.querySelector('[data-view=chat]').click()`); await wait(700);
    if (!(await js(`!!document.querySelector('.file-card')`))) return fail('file card lost after reload');
    console.log('ok  file card restored from history');
    // 2. connectors
    if (!(await js(`getComputedStyle(document.querySelector('[data-view=osint]')).display !== 'none'`))) return fail('Osint rail hidden though beta on');
    await js(`document.querySelector('[data-view=connectors]').click()`);
    for (let i = 0; i < 30 && !(await js(`/Connected/.test(document.getElementById('cxMcp').textContent)`)); i++) await wait(300);
    const mcp = await js(`document.getElementById('cxMcp').textContent.replace(/\\s+/g, ' ')`);
    if (!/Mock Notes.*Connected.*2 tools/.test(mcp)) return fail('MCP row: ' + mcp);
    console.log('ok  MCP server connected with 2 tools');
    await js(`document.querySelector('[data-preset=github]').click()`); await wait(300);
    await js(`(() => { const e = document.getElementById('apiKey'); e.value = 'ghp_testtoken1234'; })()`);
    await shot('connectors-form');
    await js(`document.getElementById('apiSave').click()`); await wait(800);
    const apis = await js(`document.getElementById('cxApis').textContent.replace(/\\s+/g, ' ')`);
    if (!/GitHub.*https:\/\/api\.github\.com.*ghp_/.test(apis)) return fail('API row: ' + apis);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
    if (!saved.apiConnectors[0].apiKeyEnc || JSON.stringify(saved).includes('ghp_testtoken1234')) return fail('api key not encrypted in settings');
    console.log('ok  GitHub preset saved, key encrypted');
    await js(`document.querySelector('.cx-row.mcp details').open = true`);
    await shot('connectors');
    // 3. Osint screen
    await js(`document.querySelector('[data-view=osint]').click()`); await wait(700);
    await shot('osint');
    await js(`document.querySelectorAll('.osint-card')[2].click()`); await wait(500);
    const v = await js(`document.getElementById('input').value`);
    if (!/^Osint: full recon on the domain/.test(v)) return fail('osint card did not prefill: ' + v);
    console.log('ok  Osint card prefills the chat');
    // 4. settings card
    await js(`document.querySelector('[data-view=settings]').click()`); await wait(500);
    await js(`document.getElementById('s-osintBeta').closest('.card').scrollIntoView()`); await shot('settings-osint');
    console.log('PASS v10-e2e');
    app.exit(0);
  } catch (e) { fail(e.stack); }
});
