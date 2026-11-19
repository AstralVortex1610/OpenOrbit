// Copies the Windows cloudflared into build/cloudflared/win32-x64/ (packed as resources/cloudflared/ by
// electron-builder), after checking it against the SHA256SUMS published next to it.
//   CLOUDFLARED_DIR=/path/with/cloudflared-windows-amd64.exe+SHA256SUMS node build/bundle-cloudflared.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const src = process.env.CLOUDFLARED_DIR || path.join(__dirname, '..', '..', 'cloudflared');
const name = 'cloudflared-windows-amd64.exe';
const dest = path.join(__dirname, 'cloudflared', 'win32-x64', 'cloudflared.exe');
const sums = fs.readFileSync(path.join(src, 'SHA256SUMS'), 'utf8');
const want = (sums.split('\n').map(l => l.trim().split(/\s+/)).find(p => p[1] && p[1].replace(/^\*/, '') === name) || [])[0];
if (!want) throw new Error(`no ${name} line in SHA256SUMS`);
const buf = fs.readFileSync(path.join(src, name));
const got = crypto.createHash('sha256').update(buf).digest('hex');
if (got !== want) throw new Error(`cloudflared checksum mismatch: ${got} != ${want}`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, buf);
let ver = ''; try { ver = fs.readFileSync(path.join(src, 'VERSION'), 'utf8').trim(); } catch {}
console.log(`cloudflared ${ver} verified (sha256 ${got.slice(0, 12)}...) -> ${path.relative(process.cwd(), dest)}`);
