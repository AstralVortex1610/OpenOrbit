// Osint tools: EXIF/GPS offline; network lookups when online (skipped if offline).
const path = require('path');
const { readExif, buildOsint, OSINT_SCHEMAS } = require('../src/osint');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok ', m); };
(async () => {
  const fs = require('fs');
  const ex = readExif(fs.readFileSync(path.join(__dirname, 'fixtures', 'gps.jpg')));
  assert(ex.Make === 'Google' && ex.Model === 'Pixel 9', 'EXIF camera');
  assert(Math.abs(ex.gps.lat - 12.9715) < 0.001 && Math.abs(ex.gps.lon - 77.5947) < 0.001, `GPS ${ex.gps.lat},${ex.gps.lon}`);
  const store = { getSettings: () => ({}) };
  const t = buildOsint({ agent: {}, store, lane: { id: 'main' }, browser: null });
  assert(OSINT_SCHEMAS.every(s => typeof t[s.function.name] === 'function'), 'every Osint schema has a tool');
  const meta = await t.image_metadata({ path: path.join(__dirname, 'fixtures', 'gps.jpg') });
  assert(/GPS found/.test(meta), 'image_metadata reports GPS');
  if (process.env.OFFLINE) return console.log('PASS osint-test (offline)');
  const live = async (name, args, re) => { try { const r = await t[name](args); const ok = re.test(r); console.log(ok ? 'ok ' : 'WARN', name, '→', r.split('\n').slice(0, 2).join(' | ').slice(0, 140)); return ok; } catch (e) { console.log('WARN', name, e.message); return false; } };
  const res = await Promise.all([
    live('place_lookup', { query: `${ex.gps.lat},${ex.gps.lon}` }, /Bengaluru|Bangalore|Karnataka/i),
    live('whois_lookup', { domain: 'github.com' }, /registration|Nameservers/i),
    live('dns_lookup', { name: 'github.com' }, /A: \d/),
    live('subdomains', { domain: 'vercel.app' }, /names for/),
    live('ip_lookup', { ip: '1.1.1.1' }, /ASN|Network/),
    live('site_tech', { url: 'orbit-agent-app.vercel.app' }, /Detected/),
    live('wayback', { url: 'github.com' }, /snapshots/),
    live('org_lookup', { name: 'Infosys' }, /Infosys/i),
    live('public_figure', { name: 'Sundar Pichai' }, /Google|Alphabet/),
    live('breach_check', { email: 'me@example.com' }, /No Have I Been Pwned key/),
  ]);
  console.log(`${res.filter(Boolean).length}/${res.length} live lookups ok`);
  console.log('PASS osint-test');
})();
