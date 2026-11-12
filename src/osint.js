// Orbit — Osint toolkit (hidden beta). Open-source intelligence on images, places, products,
// domains, infrastructure, organisations and public figures. Public sources only, always cited.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const UA = { 'User-Agent': 'Orbit/0.10 (+https://github.com/AstralVortex1610/OpenOrbit)' };
const j = async (url, opts = {}) => { const r = await fetch(url, { ...opts, headers: { ...UA, Accept: 'application/json', ...(opts.headers || {}) } }); const t = await r.text(); if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}: ${t.slice(0, 160)}`); try { return JSON.parse(t); } catch { throw new Error(`Bad JSON from ${new URL(url).host}`); } };
const cleanDomain = (d) => String(d || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();

// ---------- EXIF (JPEG / TIFF) ----------
const TAGS = { 0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9011: 'OffsetTimeOriginal', 0x920a: 'FocalLength', 0x829a: 'ExposureTime', 0x829d: 'FNumber', 0x8827: 'ISO', 0xa434: 'LensModel', 0xa433: 'LensMake', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0x0112: 'Orientation', 0x010e: 'ImageDescription', 0xa420: 'ImageUniqueID', 0xa431: 'BodySerialNumber' };
const GPS = { 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude', 5: 'GPSAltitudeRef', 6: 'GPSAltitude', 7: 'GPSTimeStamp', 17: 'GPSImgDirection', 29: 'GPSDateStamp' };
function readExif(buf) {
  let off = -1;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 4) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1]; const len = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.toString('ascii', i + 4, i + 10) === 'Exif\0\0') { off = i + 10; break; }
      if (marker === 0xda) break;
      i += 2 + len;
    }
  } else if (buf.toString('ascii', 0, 2) === 'II' || buf.toString('ascii', 0, 2) === 'MM') off = 0;
  if (off < 0) return null;
  const le = buf.toString('ascii', off, off + 2) === 'II';
  const u16 = (p) => le ? buf.readUInt16LE(off + p) : buf.readUInt16BE(off + p);
  const u32 = (p) => le ? buf.readUInt32LE(off + p) : buf.readUInt32BE(off + p);
  const i32 = (p) => le ? buf.readInt32LE(off + p) : buf.readInt32BE(off + p);
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const out = {};
  const ifd = (start, map, depth = 0) => {
    if (depth > 3 || start <= 0 || off + start + 2 > buf.length) return;
    const n = u16(start);
    for (let k = 0; k < n; k++) {
      const e = start + 2 + k * 12; if (off + e + 12 > buf.length) break;
      const tag = u16(e); const type = u16(e + 2); const count = u32(e + 4);
      const size = (SIZES[type] || 1) * count; const vp = size > 4 ? u32(e + 8) : e + 8;
      if (tag === 0x8769 || tag === 0x8825) { ifd(u32(e + 8), tag === 0x8825 ? GPS : TAGS, depth + 1); continue; }
      const name = map[tag]; if (!name || off + vp + size > buf.length) continue;
      let v;
      if (type === 2) v = buf.toString('utf8', off + vp, off + vp + count).replace(/\0+$/, '').trim();
      else if (type === 3) v = count === 1 ? u16(vp) : Array.from({ length: Math.min(count, 4) }, (_, q) => u16(vp + q * 2));
      else if (type === 4) v = u32(vp);
      else if (type === 5 || type === 10) { const rd = (q) => { const a = type === 5 ? u32(vp + q * 8) : i32(vp + q * 8); const b = type === 5 ? u32(vp + q * 8 + 4) : i32(vp + q * 8 + 4); return b ? a / b : 0; }; v = count === 1 ? rd(0) : Array.from({ length: Math.min(count, 4) }, (_, q) => rd(q)); }
      else if (type === 1 || type === 7) v = count <= 4 ? Array.from(buf.subarray(off + vp, off + vp + count)) : `(${count} bytes)`;
      out[name] = v;
    }
  };
  ifd(u32(4), TAGS);
  const dms = (a) => Array.isArray(a) ? a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600 : null;
  if (out.GPSLatitude && out.GPSLongitude) {
    let lat = dms(out.GPSLatitude); let lon = dms(out.GPSLongitude);
    if (/S/i.test(out.GPSLatitudeRef || '')) lat = -lat; if (/W/i.test(out.GPSLongitudeRef || '')) lon = -lon;
    out.gps = { lat: +lat.toFixed(6), lon: +lon.toFixed(6), map: `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}` };
  }
  return out;
}
function pngText(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  const out = {}; let i = 8;
  while (i < buf.length - 12) {
    const len = buf.readUInt32BE(i); const type = buf.toString('ascii', i + 4, i + 8);
    if (type === 'tEXt' || type === 'iTXt') { const d = buf.subarray(i + 8, i + 8 + len); const z = d.indexOf(0); out[d.toString('latin1', 0, z)] = d.toString('utf8', z + 1).replace(/^[\0\s]+/, '').slice(0, 500); }
    if (type === 'eXIf') Object.assign(out, readExif(buf.subarray(i + 8, i + 8 + len)) || {});
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return out;
}

async function loadImage(src) {
  if (/^data:/.test(src)) return Buffer.from(src.split(',')[1], 'base64');
  if (/^https?:/.test(src)) { const r = await fetch(src, { headers: UA }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
  return fs.readFileSync(src);
}

// ---------- tools ----------
const TECH = [
  ['WordPress', /wp-content|wp-includes/i], ['Shopify', /cdn\.shopify|Shopify\.theme/i], ['Wix', /wixstatic|_wixCssImports/i], ['Squarespace', /squarespace/i], ['Webflow', /webflow/i],
  ['Next.js', /__NEXT_DATA__|_next\/static/i], ['Nuxt', /__NUXT__|_nuxt\//i], ['React', /react(-dom)?(\.production)?\.min\.js|data-reactroot/i], ['Vue', /vue(\.runtime)?(\.min)?\.js|data-v-[0-9a-f]{6}/i], ['Angular', /ng-version=/i], ['Svelte', /svelte-[a-z0-9]{6}/i],
  ['Google Analytics', /googletagmanager\.com\/gtag|google-analytics\.com/i], ['Google Tag Manager', /googletagmanager\.com\/gtm/i], ['Meta Pixel', /connect\.facebook\.net\/.*fbevents/i], ['Hotjar', /static\.hotjar/i], ['Vercel Analytics', /_vercel\/insights|vercel-insights/i],
  ['Cloudflare', /cdn-cgi\//i], ['jQuery', /jquery(\.min)?\.js/i], ['Bootstrap', /bootstrap(\.min)?\.(css|js)/i], ['Tailwind', /tailwind/i], ['Stripe', /js\.stripe\.com/i], ['Razorpay', /checkout\.razorpay/i], ['reCAPTCHA', /recaptcha/i], ['Intercom', /widget\.intercom/i],
];

function buildOsint({ agent, store, lane, browser }) {
  return {
    async image_metadata({ path: p }) {
      const buf = await loadImage(p);
      const meta = readExif(buf) || pngText(buf) || {};
      const size = `${(buf.length / 1024).toFixed(0)} KB`;
      if (!Object.keys(meta).length) return `No EXIF or embedded metadata in this image (${size}). It was probably stripped (most social apps do this). Use visual clues and reverse_image_search instead.`;
      return `Metadata (${size}):\n` + Object.entries(meta).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n') + (meta.gps ? `\n\nGPS found. Reverse-geocode it with place_lookup using "${meta.gps.lat},${meta.gps.lon}".` : '');
    },

    async reverse_image_search({ path: p, engine }) {
      const b = browser;
      const eng = engine || 'google';
      const isUrl = /^https?:/.test(p);
      if (isUrl) {
        const u = eng === 'yandex' ? `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(p)}` : eng === 'bing' ? `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${encodeURIComponent(p)}` : `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(p)}`;
        return b.navigate(u);
      }
      const file = path.resolve(p);
      if (!fs.existsSync(file)) throw new Error(`No file at ${file}.`);
      await b.navigate(eng === 'yandex' ? 'https://yandex.com/images/' : eng === 'bing' ? 'https://www.bing.com/visualsearch' : 'https://lens.google.com/');
      const page = b.page;
      const input = await page.$('input[type=file]');
      if (!input) return `Opened ${eng} image search but couldn't find its upload box. Use browser_snapshot and click the camera/upload button, then try again.`;
      await input.setInputFiles(file);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(4000);
      return b.snapshot();
    },

    async place_lookup({ query }) {
      const q = String(query || '').trim();
      const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (m) {
        const r = await j(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${m[1]}&lon=${m[2]}&zoom=18&addressdetails=1`);
        return `${r.display_name || 'Unknown place'}\nType: ${r.type || ''} ${r.category || ''}\nMap: https://www.openstreetmap.org/?mlat=${m[1]}&mlon=${m[2]}#map=17/${m[1]}/${m[2]}\nSource: OpenStreetMap Nominatim`;
      }
      const r = await j(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&q=${encodeURIComponent(q)}`);
      if (!r.length) return 'No match on OpenStreetMap. Try a different name or nearby landmark.';
      return r.map(p => `${p.display_name}\n  ${p.lat},${p.lon} · ${p.type} · https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=16/${p.lat}/${p.lon}`).join('\n') + '\nSource: OpenStreetMap Nominatim';
    },

    async whois_lookup({ domain }) {
      const d = cleanDomain(domain);
      const r = await j(`https://rdap.org/domain/${encodeURIComponent(d)}`);
      const ev = (r.events || []).map(e => `${e.eventAction}: ${String(e.eventDate).slice(0, 10)}`).join(', ');
      const ents = (r.entities || []).map(e => {
        const v = (e.vcardArray && e.vcardArray[1]) || []; const fn = (v.find(x => x[0] === 'fn') || [])[3]; const org = (v.find(x => x[0] === 'org') || [])[3];
        return `${(e.roles || []).join('/')}: ${[fn, org].filter(Boolean).join(', ') || '(redacted)'}`;
      }).join('\n');
      return `Domain: ${r.ldhName || d}\nStatus: ${(r.status || []).join(', ')}\nEvents: ${ev}\nNameservers: ${(r.nameservers || []).map(n => n.ldhName).join(', ')}\n${ents}\nSource: RDAP (rdap.org)`;
    },

    async dns_lookup({ name, types }) {
      const d = cleanDomain(name);
      const want = (types && types.length ? types : ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA', 'CAA']).map(t => String(t).toUpperCase());
      const lines = [];
      await Promise.all(want.map(async t => {
        try { const r = await dns.resolve(d, t); lines.push(`${t}: ${r.map(x => typeof x === 'string' ? x : Array.isArray(x) ? x.join('') : JSON.stringify(x)).join(' | ')}`); }
        catch (e) { if (!/ENODATA|ENOTFOUND/.test(e.code)) lines.push(`${t}: ${e.code}`); }
      }));
      try { const dm = await dns.resolve(`_dmarc.${d}`, 'TXT'); lines.push(`DMARC: ${dm.map(x => x.join('')).join(' | ')}`); } catch {}
      return `DNS for ${d}\n${lines.sort().join('\n') || '(no records)'}`;
    },

    async subdomains({ domain }) {
      const d = cleanDomain(domain);
      const r = await j(`https://crt.sh/?q=${encodeURIComponent('%.' + d)}&output=json`);
      const names = new Set();
      for (const c of r) String(c.name_value || '').split('\n').forEach(n => { n = n.trim().toLowerCase().replace(/^\*\./, ''); if (n.endsWith(d)) names.add(n); });
      const list = [...names].sort();
      return `${list.length} names for ${d} in public certificate logs:\n${list.slice(0, 300).join('\n')}${list.length > 300 ? `\n…and ${list.length - 300} more` : ''}\nSource: crt.sh`;
    },

    async ip_lookup({ ip }) {
      let addr = String(ip || '').trim();
      if (!/^[\d.:a-f]+$/i.test(addr)) { const r = await dns.resolve4(cleanDomain(addr)); addr = r[0]; }
      const [geo, rdap] = await Promise.all([j(`https://ipwho.is/${addr}`).catch(() => ({})), j(`https://rdap.org/ip/${addr}`).catch(() => ({}))]);
      return `IP ${addr}\nNetwork: ${rdap.name || ''} ${rdap.handle || ''} (${rdap.startAddress || ''} – ${rdap.endAddress || ''})\nOrg/ISP: ${(geo.connection && (geo.connection.org || geo.connection.isp)) || ''}\nASN: ${(geo.connection && geo.connection.asn) || ''}\nApprox. location: ${[geo.city, geo.region, geo.country].filter(Boolean).join(', ')} (IP geolocation is city-level at best)\nSources: ipwho.is, RDAP`;
    },

    async site_tech({ url }) {
      const u = /^https?:/.test(url) ? url : `https://${url}`;
      const r = await fetch(u, { headers: { ...UA, Accept: 'text/html' }, redirect: 'follow' });
      const html = (await r.text()).slice(0, 600000);
      const h = Object.fromEntries(r.headers.entries());
      const found = TECH.filter(([, re]) => re.test(html)).map(([n]) => n);
      const gen = (html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i) || [])[1];
      const title = (html.match(/<title[^>]*>([^<]{0,200})/i) || [])[1];
      const ids = [...new Set([...(html.match(/\bG-[A-Z0-9]{6,12}\b|\bUA-\d{4,10}-\d+\b|\bGTM-[A-Z0-9]{5,8}\b|\bca-pub-\d{10,20}\b/g) || [])])];
      const socials = [...new Set((html.match(/https?:\/\/(?:www\.)?(?:twitter|x|facebook|instagram|linkedin|youtube|github|t)\.(?:com|me)\/[A-Za-z0-9_./-]{2,60}/g) || []))].slice(0, 15);
      return `${r.url} → HTTP ${r.status}\nTitle: ${title || ''}\nServer: ${h.server || ''}${h['x-powered-by'] ? ' · ' + h['x-powered-by'] : ''}${h['cf-ray'] ? ' · Cloudflare' : ''}${h['x-vercel-id'] ? ' · Vercel' : ''}\nGenerator: ${gen || ''}\nDetected: ${found.join(', ') || 'nothing obvious'}\nAnalytics/ad IDs (shared IDs link sites to one owner): ${ids.join(', ') || 'none'}\nLinked socials: ${socials.join(' ') || 'none'}`;
    },

    async wayback({ url, limit }) {
      const u = String(url).replace(/^https?:\/\//, '');
      const rows = await j(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(u)}&output=json&fl=timestamp,statuscode,original&collapse=timestamp:6&limit=${Math.min(Number(limit) || 40, 200)}`);
      if (rows.length <= 1) return `No snapshots of ${u} in the Wayback Machine.`;
      return `${rows.length - 1} monthly snapshots of ${u}:\n` + rows.slice(1).map(([t, s, o]) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} (${s}) https://web.archive.org/web/${t}/${o}`).join('\n');
    },

    async org_lookup({ name }) {
      const q = encodeURIComponent(String(name || '').trim());
      const [lei, wd] = await Promise.all([
        j(`https://api.gleif.org/api/v1/fuzzycompletions?field=entity.legalName&q=${q}`).catch(() => ({ data: [] })),
        j(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=en&type=item&limit=5&format=json`).catch(() => ({ search: [] })),
      ]);
      const out = [];
      for (const d of (lei.data || []).slice(0, 5)) {
        const id = d.relationships && d.relationships['lei-records'] && d.relationships['lei-records'].data && d.relationships['lei-records'].data.id;
        if (!id) { out.push(`LEI match: ${d.attributes.value}`); continue; }
        const r = await j(`https://api.gleif.org/api/v1/lei-records/${id}`).catch(() => null);
        const e = r && r.data && r.data.attributes && r.data.attributes.entity;
        if (e) out.push(`LEI ${id}: ${e.legalName.name} · ${e.legalForm && e.legalForm.id || ''} · ${e.status} · ${e.legalAddress.city}, ${e.legalAddress.country} · reg. ${e.registeredAs || ''}`);
      }
      for (const s of (wd.search || [])) out.push(`Wikidata ${s.id}: ${s.label}${s.description ? ' · ' + s.description : ''} · https://www.wikidata.org/wiki/${s.id}`);
      return (out.join('\n') || 'No matches in GLEIF or Wikidata.') + '\nFor Indian companies also search the MCA master data (mca.gov.in) and news with web_search. Sources: GLEIF, Wikidata';
    },

    async public_figure({ name }) {
      const q = encodeURIComponent(String(name || '').trim());
      const s = await j(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=en&type=item&limit=5&format=json`);
      const hits = s.search || [];
      if (!hits.length) return 'Not found on Wikidata. If this person has no public role (no Wikipedia/Wikidata page, not an official, executive, artist or other public figure), stop: Osint does not profile private individuals.';
      const top = hits[0];
      const e = await j(`https://www.wikidata.org/wiki/Special:EntityData/${top.id}.json`);
      const ent = e.entities[top.id]; const c = ent.claims || {};
      const ids = (p) => (c[p] || []).map(x => x.mainsnak.datavalue && x.mainsnak.datavalue.value).filter(Boolean);
      const label = async (qs) => { const list = qs.map(v => v.id).filter(Boolean).slice(0, 8); if (!list.length) return ''; const r = await j(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${list.join('|')}&props=labels&languages=en&format=json`); return list.map(i => r.entities[i] && r.entities[i].labels.en && r.entities[i].labels.en.value).filter(Boolean).join(', '); };
      const isHuman = ids('P31').some(v => v.id === 'Q5');
      const [occ, emp, pos, cit] = await Promise.all([label(ids('P106')), label(ids('P108')), label(ids('P39')), label(ids('P27'))]);
      const site = ids('P856')[0]; const tw = ids('P2002')[0]; const li = ids('P6634')[0]; const ig = ids('P2003')[0]; const gh = ids('P2037')[0];
      const wiki = ent.sitelinks && ent.sitelinks.enwiki ? `https://en.wikipedia.org/wiki/${encodeURIComponent(ent.sitelinks.enwiki.title.replace(/ /g, '_'))}` : '';
      return [`${top.label} (${top.id}) · ${top.description || ''}${isHuman ? '' : ' · not a person'}`, occ && `Occupation: ${occ}`, pos && `Positions held: ${pos}`, emp && `Employers: ${emp}`, cit && `Citizenship: ${cit}`,
        [site && `Official site: ${site}`, tw && `X: https://x.com/${tw}`, ig && `Instagram: https://instagram.com/${ig}`, li && `LinkedIn: https://www.linkedin.com/in/${li}`, gh && `GitHub: https://github.com/${gh}`].filter(Boolean).join('\n'),
        wiki && `Wikipedia: ${wiki}`, `Wikidata: https://www.wikidata.org/wiki/${top.id}`, hits.length > 1 ? `Other matches: ${hits.slice(1).map(h => `${h.label} (${h.description || h.id})`).join('; ')}` : ''].filter(Boolean).join('\n') + '\nKeep to their public role. Source: Wikidata';
    },

    async breach_check({ email }) {
      const s = store.getSettings();
      if (!s.hibpKey) return `No Have I Been Pwned key saved. Open https://haveibeenpwned.com/ in the browser and check ${email} there, or add a key in Settings → Osint.`;
      const r = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`, { headers: { ...UA, 'hibp-api-key': s.hibpKey } });
      if (r.status === 404) return `${email} is not in any known breach. Source: Have I Been Pwned`;
      if (!r.ok) throw new Error(`HIBP HTTP ${r.status}`);
      const list = await r.json();
      return `${email} appears in ${list.length} breaches:\n` + list.map(b => `${b.BreachDate} ${b.Title}: ${b.DataClasses.slice(0, 6).join(', ')}`).join('\n') + '\nAdvice: change those passwords and turn on 2-step sign-in. Source: Have I Been Pwned';
    },
  };
}

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const OSINT_SCHEMAS = [
  fn('image_metadata', 'Osint: read EXIF/embedded metadata from an image file or URL: camera, date taken, software, and GPS coordinates if present.', { path: { type: 'string', description: 'File path, URL or data URL.' } }, ['path']),
  fn('reverse_image_search', 'Osint: run a reverse image search (Google Lens, Bing or Yandex) in the browser for a local image file or image URL, and return what the results page shows. Yandex is strongest for places and buildings.', { path: { type: 'string' }, engine: { type: 'string', enum: ['google', 'bing', 'yandex'] } }, ['path']),
  fn('place_lookup', 'Osint: geocode a place name, or reverse-geocode "lat,lon" into an address, via OpenStreetMap.', { query: { type: 'string' } }, ['query']),
  fn('whois_lookup', 'Osint: domain registration (RDAP/WHOIS): registrar, dates, status, nameservers, registrant org if public.', { domain: { type: 'string' } }, ['domain']),
  fn('dns_lookup', 'Osint: DNS records for a domain (A, AAAA, MX, NS, TXT, CNAME, SOA, CAA, DMARC).', { name: { type: 'string' }, types: { type: 'array', items: { type: 'string' } } }, ['name']),
  fn('subdomains', 'Osint: subdomains of a domain from public certificate-transparency logs (crt.sh).', { domain: { type: 'string' } }, ['domain']),
  fn('ip_lookup', 'Osint: owner network, ASN, ISP and approximate city for an IP address or a domain.', { ip: { type: 'string' } }, ['ip']),
  fn('site_tech', 'Osint: what a website runs on (CMS, frameworks, hosting, analytics), its shared analytics/ad IDs, and linked social accounts.', { url: { type: 'string' } }, ['url']),
  fn('wayback', 'Osint: Internet Archive snapshots of a URL over time, one per month.', { url: { type: 'string' }, limit: { type: 'number' } }, ['url']),
  fn('org_lookup', 'Osint: look up an organisation in GLEIF (legal entity, LEI, registered address, status) and Wikidata.', { name: { type: 'string' } }, ['name']),
  fn('public_figure', 'Osint: public profile of a public figure (politician, executive, celebrity, athlete, author) from Wikidata: role, positions, employers, official accounts. Refuses private individuals.', { name: { type: 'string' } }, ['name']),
  fn('breach_check', 'Osint: check whether the USER\'S OWN email address appears in known data breaches (Have I Been Pwned). Only for the user\'s own addresses or their organisation\'s.', { email: { type: 'string' } }, ['email']),
];

const OSINT_PROMPT = `# Osint (beta, on)
You have open-source intelligence tools. Work like an analyst: gather from several sources, cross-check, separate fact from inference, give a confidence (high/medium/low) and cite every source link.
- "Where is this?" for a photo: image_metadata first (GPS ends the hunt), then read the image yourself for clues (script on signs, plates, road markings, architecture, vegetation, sun angle, shop names), reverse_image_search (try yandex for places), confirm with place_lookup and web_search. Give the best guess, the clues, and alternatives. If they want to go there, offer flights with the browser and ask before booking.
- A product in a photo: identify brand and model exactly, then compare current prices on Amazon.in, Flipkart, Croma, Reliance Digital and the brand store (start_task one per store for speed). Reply with a table: store, price, seller, delivery, link. Flag refurbished or suspicious listings.
- Domains and sites: whois_lookup, dns_lookup, subdomains, ip_lookup, site_tech, wayback. Shared analytics IDs can link sites to one owner.
- Organisations: org_lookup plus web_search for filings, leadership, news and official accounts.
- People: only public figures in their public role (public_figure + news). Never build a profile of a private individual: no username sweeps across sites, no finding where someone lives, works, or who their family is, no combining data about them from other apps or leaks. If asked, say plainly that Osint doesn't profile private people, and offer what you can do instead.
- breach_check is only for the user's own (or their organisation's) addresses.
- When a finding is worth keeping, offer to export it with make_file (PDF by default).`;

module.exports = { buildOsint, OSINT_SCHEMAS, OSINT_PROMPT, readExif };
