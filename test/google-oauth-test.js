// Google connect: PKCE + loopback redirect + code exchange, against a mock token endpoint.
const http = require('http'); const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const tok = http.createServer((req, res) => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
  const p = new URLSearchParams(b);
  assert.equal(p.get('grant_type'), 'authorization_code'); assert.equal(p.get('code'), 'CODE1'); assert(p.get('code_verifier').length > 40); assert(p.get('redirect_uri').startsWith('http://127.0.0.1:'));
  const idt = 'x.' + Buffer.from(JSON.stringify({ email: 'affanm2010@gmail.com' })).toString('base64url') + '.y';
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, id_token: idt }));
}); });
tok.listen(0, async () => {
  process.env.ORBIT_GOOGLE_TOKEN_URL = `http://127.0.0.1:${tok.address().port}`;
  const { Store } = require('../src/store'); const { Google } = require('../src/google');
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'og-')), null);
  store.saveSettings({ googleClientId: 'cid.apps.googleusercontent.com', googleClientSecret: 'sec' });
  const g = new Google(store);
  const email = await g.connect(async (url) => {
    const u = new URL(url);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert(u.searchParams.get('scope').includes('gmail.modify')); assert.equal(u.searchParams.get('access_type'), 'offline');
    const r = await fetch(`${u.searchParams.get('redirect_uri')}/?code=CODE1&state=${u.searchParams.get('state')}`);
    assert((await r.text()).includes('connected'));
  });
  assert.equal(email, 'affanm2010@gmail.com');
  const s = store.getSettings(); assert.equal(s.googleRefresh, 'RT'); assert.equal(s.googleEmail, 'affanm2010@gmail.com'); assert(g.connected());
  g.disconnect(); assert(!g.connected());
  console.log('google oauth connect/disconnect: PASS'); process.exit(0);
});
