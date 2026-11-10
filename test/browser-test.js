process.env.ORBIT_HEADLESS = '1';
const http = require('http'); const os = require('os'); const path = require('path'); const fs = require('fs');
const { Browser } = require('../src/browser');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-'));
const store = { dir, getSettings: () => ({ browserChannel: 'chromium' }) };
const html = `<html><title>Shop</title><body><h1>Test shop</h1><input placeholder="Search" id=q><button onclick="document.getElementById('out').innerText='Searched: '+q.value">Go</button><a href="/two">Next page</a><p id=out></p></body></html>`;
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url === '/two' ? '<title>Two</title><p>Page two</p>' : html); }).listen(0, async () => {
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const b = new Browser(store);
  let s = await b.navigate(url); console.log(s.split('\n').slice(0, 9).join('\n'));
  const ref = (label) => s.match(new RegExp(`\\[(\\d+)\\][^\\n]*${label}`))[1];
  s = await b.type(ref('Search'), 'blue mug');
  s = await b.click(ref('"Go"')); if (!/Searched: blue mug/.test(s)) throw new Error('type/click failed');
  s = await b.click(ref('Next page')); if (!/Page two/.test(s)) throw new Error('nav failed');
  s = await b.back(); const shot = await b.screenshot(); if (!shot.image.startsWith('data:image/jpeg')) throw new Error('shot');
  await b.close(); srv.close(); console.log('BROWSER PASS');
});
