// Lets the NSIS installer build on Linux/ARM without Wine: electron-builder already ships a
// pure-JS reader that extracts the uninstaller (used on macOS); this makes Linux use it too.
const fs = require('fs');
const f = require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js');
let s = fs.readFileSync(f, 'utf8');
const from = 'if ((0, macosVersion_1.isMacOsCatalina)()) {';
const to = 'if ((0, macosVersion_1.isMacOsCatalina)() || process.platform === "linux") {';
if (s.includes(to)) console.log('nsis patch: already applied');
else if (s.includes(from)) { fs.writeFileSync(f, s.replace(from, to)); console.log('nsis patch: applied'); }
else console.log('nsis patch: pattern not found (electron-builder changed); skipping');
