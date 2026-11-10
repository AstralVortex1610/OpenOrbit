// Full app + mock model: Home panels fill in, a project chat writes a file and updates its brief, Updates collects it all.
// Run: xvfb-run -a npx electron --no-sandbox test/hub-e2e.js
const { app, BrowserWindow } = require('electron');
const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-hub-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();

const PANELS = {
  'Bitcoin': { title: 'Bitcoin', kind: 'stat', value: '₹58.2L', delta: '+2.4% today', trend: 'up', sub: 'BTC/INR on WazirX', source: 'coingecko.com', link: 'https://www.coingecko.com/en/coins/bitcoin' },
  'JEE Main countdown': { title: 'JEE Main countdown', kind: 'progress', value: '68', unit: 'days', progress: 0.62, sub: 'Session 1 starts Jan 22, 2027', source: 'jeemain.nta.nic.in' },
  'GitHub trending AI': { title: 'GitHub trending AI', kind: 'list', sub: 'Stars gained today', source: 'github.com', items: [
    { label: 'deepseek-ai/DeepSeek-V4', value: '+3.1k', url: 'https://github.com/deepseek-ai' }, { label: 'openai/codex', value: '+1.8k', url: 'https://github.com/openai/codex' },
    { label: 'huggingface/smolagents', value: '+940', url: 'https://github.com/huggingface/smolagents' }, { label: 'ollama/ollama', value: '+610', url: 'https://github.com/ollama/ollama' } ] },
  'Mysuru weather': { title: 'Mysuru weather', kind: 'stat', value: '24°', unit: 'C', sub: 'Light rain after 4 pm · High 28° Low 19°', source: 'weather.com' },
};
let projCalls = 0;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
    const j = JSON.parse(body); const sys = j.messages[0].content; const last = j.messages[j.messages.length - 1];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sse = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const text = (t) => { sse({ choices: [{ delta: { content: t } }], usage: { total_tokens: 50 } }); };
    if (sys.includes('glanceable panel')) {
      const title = (j.messages[1].content.match(/Home: "([^"]+)"/) || [])[1];
      setTimeout(() => { text(JSON.stringify(PANELS[title] || { kind: 'text', text: 'ok' })); res.write('data: [DONE]\n\n'); res.end(); }, 700);
      return;
    }
    if (sys.includes('# PROJECT:')) {
      const folder = (sys.match(/Project files folder: (.+)/) || [])[1].trim();
      if (last.role === 'user' && ++projCalls === 1) {
        sse({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'w1', function: { name: 'write_file', arguments: JSON.stringify({ path: path.join(folder, 'plan.md'), content: '# RideCompare plan\n\n1. Fare APIs\n2. UI\n' }) } },
          { index: 1, id: 'b1', function: { name: 'project_brief', arguments: JSON.stringify({ content: '# RideCompare\n\n## Goal\nCompare Uber, Ola, Rapido and Namma Yatri fares in one tap.\n\n## Decisions\n- Expo + React Native\n\n## Files\n- plan.md: build plan\n\n## Open threads\n- Get Namma Yatri API access\n' }) } },
        ] } }] });
      } else text("Saved a build plan to **plan.md** and set the brief. Next up: wiring the Namma Yatri fare API. Want me to start on it?");
      res.write('data: [DONE]\n\n'); res.end(); return;
    }
    text('Done.'); res.write('data: [DONE]\n\n'); res.end();
  });
});

server.listen(0, () => {
  fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({ apiKeyEnc: Buffer.from('k').toString('base64'), baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'm', userName: 'Affan', closeToTray: false }));
  // a scheduled-run update and a background task update, as if they happened earlier
  fs.writeFileSync(path.join(tmp, 'updates.json'), JSON.stringify([
    { id: 'u1', at: Date.now() - 3 * 3600e3, read: false, kind: 'task', title: 'Morning brief', text: "**Today:** Physics mock test at 4 pm, 2 chapters of organic left.\n\nAlso, the RideCompare repo got its first star.", target: { view: 'chat' } },
    { id: 'u2', at: Date.now() - 26 * 3600e3, read: true, kind: 'worker', title: 'Compare laptops', text: 'The ASUS Vivobook 16 wins at ₹62,990: 16 GB RAM, best screen in the budget.', target: { view: 'chat' } },
  ]));
  require('../src/main.js');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const shot = async (win, name) => fs.writeFileSync(path.join(__dirname, name), (await win.webContents.capturePage()).toPNG());
  app.whenReady().then(async () => {
    await wait(2500);
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1280, 820); win.show();
    const js = (s) => win.webContents.executeJavaScript(s);
    await shot(win, 'shot-v7-home-empty.png');
    for (const [t, p] of [['Bitcoin', 'Bitcoin price in INR'], ['JEE Main countdown', 'Days until JEE Main session 1'], ['GitHub trending AI', 'Top trending AI repos'], ['Mysuru weather', 'Weather in Mysuru']])
      await js(`orbit.panels.create({ title: ${JSON.stringify(t)}, prompt: ${JSON.stringify(p)}, everyMinutes: 180 })`);
    await js(`document.querySelector('[data-view=projects]').click(); document.querySelector('[data-view=home]').click()`);
    await wait(400); await shot(win, 'shot-v7-home-building.png');
    await wait(3500);
    const panels = await js('orbit.panels.list()');
    console.log('panels:', panels.map(p => `${p.title}=${p.status}`).join(', '));
    // project
    const p = await js(`orbit.projects.create({ name: 'RideCompare', about: 'One app to compare cab fares across Uber, Ola, Rapido and Namma Yatri.' })`);
    await js(`orbit.projects.create({ name: 'JEE 2027', about: 'Study plan, mock tests and weak topics.' })`);
    await js(`document.querySelector('[data-view=projects]').click()`); await wait(700);
    await shot(win, 'shot-v7-projects.png');
    await js(`document.querySelector('.proj-card[data-id="${p.id}"]').click()`); await wait(700);
    await js(`const i=document.querySelector('#input'); i.value='Make a build plan for the app and save it'; document.querySelector('#composer').requestSubmit()`);
    await wait(2500);
    await js(`document.querySelector('#drawerBtn').click()`); await wait(900);
    await shot(win, 'shot-v7-project-chat.png');
    const pr = await js(`orbit.projects.get('${p.id}')`);
    console.log('project files:', pr.fileList.map(f => f.name).join(','), '| brief set:', pr.brief.includes('Expo'));
    // a reply in a project you aren't looking at -> Updates
    await js(`document.querySelector('[data-view=home]').click()`); await wait(300);
    await js(`orbit.projects.send('${p.id}', 'continue', [])`); await wait(2500);
    await shot(win, 'shot-v7-home.png');
    await js(`document.querySelector('[data-view=updates]').click()`); await wait(900);
    await shot(win, 'shot-v7-updates.png');
    const ups = await js('orbit.updates.list()');
    console.log('updates:', ups.map(u => u.kind + ':' + u.title).join(', '));
    await js(`document.documentElement.dataset.theme='light'; document.querySelector('[data-view=home]').click()`); await wait(900);
    await shot(win, 'shot-v7-home-light.png');
    const ok = panels.every(p => p.status === 'ok') && pr.fileList.some(f => f.name === 'plan.md') && pr.brief.includes('Expo') && ups.some(u => u.kind === 'project');
    console.log(ok ? 'PASS' : 'FAIL'); app.exit(ok ? 0 : 1);
  });
});
