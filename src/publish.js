// Orbit — publish a folder as a live website on Netlify (file-digest deploy, no zip needed).
// Needs a Netlify personal access token (Settings → Accounts). Same name again = update the same site.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = process.env.ORBIT_NETLIFY_API || 'https://api.netlify.com/api/v1';

function walk(dir, base = dir, out = {}) {
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.') || f === 'node_modules') continue;
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else out['/' + path.relative(base, full).split(path.sep).join('/')] = full;
  }
  return out;
}

async function publish(store, dir, name) {
  const s = store.getSettings();
  if (!s.netlifyToken) return 'Error: no Netlify token. The user can make a free one at app.netlify.com/user/applications (Personal access tokens) and paste it in Settings, then Accounts.';
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `Error: ${dir} is not a folder.`;
  const files = walk(dir);
  if (!files['/index.html']) return `Error: ${dir} has no index.html.`;
  if (Object.keys(files).length > 500) return 'Error: too many files (over 500).';
  const H = { Authorization: `Bearer ${s.netlifyToken}`, 'Content-Type': 'application/json' };
  const call = async (method, url, body, raw) => {
    const r = await fetch(API + url, { method, headers: raw ? { Authorization: H.Authorization, 'Content-Type': 'application/octet-stream' } : H, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Netlify ${r.status}: ${j.message || j.error || ''}`);
    return j;
  };
  const slug = String(name || path.basename(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'orbit-site';
  const sites = store._read('sites.json', {});
  let siteId = sites[slug];
  if (siteId) { try { await call('GET', `/sites/${siteId}`); } catch { siteId = null; } }
  if (!siteId) {
    let site;
    try { site = await call('POST', '/sites', { name: slug }); }
    catch { site = await call('POST', '/sites', { name: `${slug}-${crypto.randomBytes(2).toString('hex')}` }); }
    siteId = site.id; sites[slug] = siteId; store._write('sites.json', sites);
  }
  const digests = {}; const bySha = {};
  for (const [p, full] of Object.entries(files)) { const sha = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex'); digests[p] = sha; bySha[sha] = full; }
  const dep = await call('POST', `/sites/${siteId}/deploys`, { files: digests });
  const need = new Set(dep.required || []);
  for (const [p, sha] of Object.entries(digests)) if (need.has(sha)) { await call('PUT', `/deploys/${dep.id}/files${p.split('/').map(encodeURIComponent).join('/')}`, fs.readFileSync(files[p]), true); need.delete(sha); }
  let url = dep.ssl_url || dep.url;
  for (let i = 0; i < 20; i++) {
    const d = await call('GET', `/deploys/${dep.id}`);
    url = d.ssl_url || d.url || url;
    if (d.state === 'ready') break;
    if (d.state === 'error') throw new Error(`Netlify deploy failed: ${d.error_message || ''}`);
    await new Promise(r => setTimeout(r, 1500));
  }
  const site = await call('GET', `/sites/${siteId}`);
  return `Published ${Object.keys(files).length} files. Live at ${site.ssl_url || site.url || url}`;
}

module.exports = { publish };
