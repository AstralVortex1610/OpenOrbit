// Run with: xvfb-run -a npx electron --no-sandbox test/docs-e2e.js  -> test/out/docs/*
const { app } = require('electron');
const fs = require('fs'); const path = require('path');
const docs = require('../src/docs');
const DOC = {
  title: 'Best laptops under ₹80,000 for coding (Nov 2026)', subtitle: 'Three picks for a student developer in Bengaluru', kind: 'Comparison',
  summary: 'Get the **ASUS Zenbook 14 OLED**: best screen and battery for the price. The Lenovo Yoga Slim 7 is the value pick.',
  content: `## The short list

| Laptop | Price | RAM | Battery | Weight |
|---|---|---|---|---|
| ASUS Zenbook 14 OLED | ₹77,990 | 16 GB | 14 h | 1.2 kg |
| Lenovo Yoga Slim 7 | ₹71,490 | 16 GB | 12 h | 1.39 kg |
| HP Pavilion Plus 14 | ₹74,999 | 16 GB | 10 h | 1.4 kg |

## Why the Zenbook wins
- 2.8K OLED screen, sharp enough for long coding sessions
- **14 hours** of battery in real use
  - charges to 60% in 50 minutes
- Weighs just 1.2 kg

### Watch out
The RAM is soldered, so buy 16 GB now. See [ASUS India](https://www.asus.com/in/).

## What to do next
1. Check the Flipkart Big Billion price drop
2. Use an HDFC card for ₹5,000 off
3. Add a 3-year warranty

> Prices change daily; recheck before buying.

\`\`\`bash
winget install Git.Git
\`\`\`
`,
  sources: ['https://www.flipkart.com/asus-zenbook-14', 'https://www.amazon.in/lenovo-yoga-slim-7', 'https://www.notebookcheck.net/zenbook-14-review'],
};
app.on('window-all-closed', () => {}); // like Orbit: closing the hidden PDF window must not quit
app.whenReady().then(async () => {
  const out = path.join(__dirname, 'out', 'docs'); fs.mkdirSync(out, { recursive: true });
  try {
    for (const f of docs.FORMATS) {
      const t = Date.now();
      const r = await docs.render({ ...DOC, format: f });
      fs.writeFileSync(path.join(out, 'report.' + r.format), r.data);
      console.log(`ok  ${f} ${r.data.length} bytes ${Date.now() - t} ms`);
    }
    const pdf = fs.readFileSync(path.join(out, 'report.pdf'));
    if (pdf.slice(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
    console.log('PASS docs-e2e');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  app.quit();
});
