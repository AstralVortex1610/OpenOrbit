// Background tasks get their own tab in the shared browser and never steal the main page.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
process.env.ORBIT_HEADLESS = '1';
const { Browser } = require('../src/browser');
const store = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ob-')), getSettings: () => ({ browserChannel: 'chromium' }) };
const http = require('http');
const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(`<title>${q.url.slice(1)}</title><button>x</button>`); });
(async () => {
  await new Promise(r => srv.listen(0, r)); const U = (t) => `http://127.0.0.1:${srv.address().port}/${t}`;
  const main = new Browser(store); const a = new Browser(store, main); const b = new Browser(store, main);
  await main.navigate(U('MAIN'));
  const [ra, rb] = await Promise.all([a.navigate(U('TASK-A')), b.navigate(U('TASK-B'))]);
  assert(ra.includes('TASK-A') && rb.includes('TASK-B'));
  await new Promise(r => setTimeout(r, 200));
  assert((await main.snapshot()).includes('Page: MAIN'), 'main page kept');
  await a.close();
  assert((await b.snapshot()).includes('TASK-B'));
  assert((await main.snapshot()).includes('MAIN'));
  await main.close();
  console.log('tabs: PASS'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
