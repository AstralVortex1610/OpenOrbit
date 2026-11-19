// Builds the Orbit Remote web bundle: the desktop renderer + the phone shims, into the Android app's assets.
//   node remote/build.js [outDir]     (default remote/android/app/src/main/assets/www)
// The desktop UI is reused as-is; only these change on the phone:
//   - src/preload.js runs against a stand-in Electron that talks to the laptop over Phone Link (shim.js)
//   - no Companion view, live-call engine, wake word or on-device voice models (those live on the laptop)
//   - mobile.css lays it out for a phone; remote-ui.js adds pairing, the offline banner and "This phone"
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'android', 'app', 'src', 'main', 'assets', 'www'));
const SKIP = new Set(['companion.js', 'companion', 'wake.js', 'vendor', 'voice', 'live.js', 'live-worklet.js', 'phonelink.js', '_voice-test.html']);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'remote'), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'renderer'))) {
  if (SKIP.has(f)) continue;
  fs.cpSync(path.join(ROOT, 'renderer', f), path.join(OUT, f), { recursive: true });
}
const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const inject = (src) => src.replace('/*__PRELOAD__*/', () => preload.split('\n').map(l => '    ' + l).join('\n'));
fs.writeFileSync(path.join(OUT, 'remote', 'shim.js'), inject(fs.readFileSync(path.join(__dirname, 'src', 'shim.js'), 'utf8')));
fs.writeFileSync(path.join(OUT, 'remote', 'frame-shim.js'), inject(fs.readFileSync(path.join(__dirname, 'src', 'frame-shim.js'), 'utf8')));
for (const f of ['remote-ui.js', 'mobile.css', 'orbiter-mobile.css']) fs.copyFileSync(path.join(__dirname, 'src', f), path.join(OUT, 'remote', f));
fs.copyFileSync(path.join(ROOT, 'src', 'link', 'proto.js'), path.join(OUT, 'remote', 'proto.js'));
fs.copyFileSync(path.join(ROOT, 'src', 'link', 'client.js'), path.join(OUT, 'remote', 'client.js'));
fs.copyFileSync(require.resolve('tweetnacl/nacl-fast.min.js'), path.join(OUT, 'remote', 'nacl-fast.min.js'));
fs.copyFileSync(require.resolve('jsqr/dist/jsQR.js'), path.join(OUT, 'remote', 'jsQR.js'));

// ---- index.html ----
let html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss: http: https: data: blob:; frame-src 'self';";
html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/, `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />\n  <meta name="theme-color" content="#1a1917" />\n  <link rel="icon" href="mark.png" />`);
html = html.replace('<link rel="stylesheet" href="styles.css" />', '<link rel="stylesheet" href="styles.css" />\n  <link rel="stylesheet" href="remote/mobile.css" />');
for (const s of ['vendor/vosk.js', 'wake.js', 'companion.js', 'voice/voice.js', 'live.js', 'phonelink.js']) html = html.replace(new RegExp(`\\s*<script src="${s.replace(/[./]/g, '\\$&')}"></script>`), '');
html = html.replace(/<aside class="companion"[\s\S]*?<\/aside>/, '');
html = html.replace(/<div class="cmp-live"[\s\S]*?(?=<div class="orb-wrap">)/, '');
html = html.replace(/\s*<option value="companion">[^<]*<\/option>/, '');
html = html.replace(/\s*<div class="card" id="plCard">[\s\S]*?<\/details>\s*<\/div>\s*<\/div>\n/, '\n');
const first = html.indexOf('<script src=');
html = html.slice(0, first) + ['remote/nacl-fast.min.js', 'remote/proto.js', 'remote/client.js', 'remote/jsQR.js', 'remote/shim.js'].map(s => `<script src="${s}"></script>`).join('\n  ') + '\n  ' + html.slice(first);
html = html.replace('</body>', '  <script src="remote/remote-ui.js"></script>\n</body>');
html = html.replace(/(<img[^>]+data-f="[a-z]+"[^>]*>\s*)+/g, ''); // any companion frames left over
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// ---- orbiter.html (the Orbiter frame) ----
let orb = fs.readFileSync(path.join(ROOT, 'renderer', 'orbiter.html'), 'utf8');
orb = orb.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self';" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />`);
orb = orb.replace('<script src="markdown.js"></script>', '<script src="remote/frame-shim.js"></script>\n  <script src="markdown.js"></script>');
orb = orb.replace('</head>', '  <link rel="stylesheet" href="remote/orbiter-mobile.css" />\n</head>');
fs.writeFileSync(path.join(OUT, 'orbiter.html'), orb);

// Sanity: nothing of the Companion view made it in.
const all = fs.readdirSync(OUT, { recursive: true }).map(String);
if (all.some(f => /companion/i.test(f)) || /companion\.js|cmp-avatar|OrbitCompanion\.setEnabled\(true/.test(html)) throw new Error('Companion view leaked into the phone build');
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'remote', 'build.json'), JSON.stringify({ app: 'Orbit Remote', remote: '0.1.0', desktop: pkg.version, built: new Date().toISOString() }));
console.log('Orbit Remote web bundle ->', OUT);
