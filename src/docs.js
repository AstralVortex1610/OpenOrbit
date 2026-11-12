// Orbit — turn research (markdown) into real files: PDF, PPTX, DOCX, HTML, Markdown, TXT, CSV.
// One parser, one terracotta design system, every format.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FORMATS = ['pdf', 'pptx', 'docx', 'html', 'md', 'txt', 'csv'];
const C = { ink: '1A1917', paper: 'F4ECDF', clay: 'C4673A', sand: 'E4A270', rust: 'AE4E27', muted: '6E655B', line: 'DCCFBD', soft: 'FAF5EC' };

// ---------- markdown -> blocks ----------
function parse(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = []; let i = 0; let para = [];
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join(' ').trim() }); para = []; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { flush(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push({ t: 'code', text: buf.join('\n') }); continue; }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); out.push({ t: 'h', level: h[1].length, text: h[2].trim() }); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush(); const row = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l); const rows = []; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push({ t: 'table', head, rows }); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush(); const ordered = /^\s*\d/.test(l); const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        items.push({ text: m[3], depth: Math.min(2, Math.floor(m[1].length / 2)) }); i++;
      }
      out.push({ t: 'list', ordered, items }); continue;
    }
    if (/^>\s?/.test(l)) { flush(); const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, '')); out.push({ t: 'quote', text: buf.join(' ') }); continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(l)) { flush(); out.push({ t: 'hr' }); i++; continue; }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l.trim()); i++;
  }
  flush();
  return out;
}
const plain = (s) => String(s || '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*]+)\*/g, '$1$2').replace(/`([^`]+)`/g, '$1').replace(/~~([^~]+)~~/g, '$1');
// inline runs: [{text, b, i, code, link}]
function runs(s) {
  const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:[^)]+\)|(?<![*\w])\*[^*\n]+\*)/g;
  let last = 0; let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith('**')) out.push({ text: t.slice(2, -2), b: true });
    else if (t.startsWith('`')) out.push({ text: t.slice(1, -1), code: true });
    else if (t.startsWith('[')) { const mm = t.match(/^\[([^\]]+)\]\((.*)\)$/); out.push({ text: mm[1], link: mm[2] }); }
    else out.push({ text: t.slice(1, -1), i: true });
    last = m.index + t.length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inlineHtml = (s) => runs(s).map(r => r.b ? `<strong>${esc(r.text)}</strong>` : r.i ? `<em>${esc(r.text)}</em>` : r.code ? `<code>${esc(r.text)}</code>` : r.link ? `<a href="${esc(r.link)}">${esc(r.text)}</a>` : esc(r.text)).join('');

// ---------- HTML (also the PDF source) ----------
function toHtml(doc) {
  const blocks = parse(doc.content);
  let body = '';
  for (const b of blocks) {
    if (b.t === 'h') { const n = Math.min(4, Math.max(2, b.level)); body += `<h${n}>${inlineHtml(b.text)}</h${n}>`; }
    else if (b.t === 'p') body += `<p>${inlineHtml(b.text)}</p>`;
    else if (b.t === 'list') body += `<${b.ordered ? 'ol' : 'ul'}>${b.items.map(it => `<li class="d${it.depth}">${inlineHtml(it.text)}</li>`).join('')}</${b.ordered ? 'ol' : 'ul'}>`;
    else if (b.t === 'table') body += `<table><thead><tr>${b.head.map(c => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r => `<tr>${r.map(c => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    else if (b.t === 'quote') body += `<blockquote>${inlineHtml(b.text)}</blockquote>`;
    else if (b.t === 'code') body += `<pre><code>${esc(b.text)}</code></pre>`;
    else if (b.t === 'hr') body += '<hr>';
  }
  const sources = (doc.sources || []).filter(Boolean);
  const date = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
body { font-family: "Segoe UI", "Inter", system-ui, sans-serif; color: #${C.ink}; background: #fff; font-size: 11pt; line-height: 1.55; margin: 0; }
.wrap { max-width: 760px; margin: 0 auto; padding: 32px 28px; }
.cover { background: #${C.ink}; color: #${C.paper}; border-radius: 18px; padding: 44px 40px 36px; margin-bottom: 30px; position: relative; overflow: hidden; }
.cover:after { content: ""; position: absolute; right: -70px; top: -90px; width: 210px; height: 210px; border-radius: 50%; border: 22px solid #${C.clay}; opacity: .9; }
.cover:before { content: ""; position: absolute; right: 52px; top: 96px; width: 14px; height: 14px; border-radius: 50%; background: #${C.sand}; }
.cover .kind { text-transform: uppercase; letter-spacing: .18em; font-size: 8.5pt; color: #${C.sand}; font-weight: 600; }
.cover h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; font-size: 28pt; line-height: 1.15; margin: 14px 0 10px; max-width: 74%; position: relative; z-index: 1; }
.cover .sub { color: #${C.line}; font-size: 12pt; max-width: 78%; }
.cover .meta { margin-top: 26px; font-size: 9pt; color: #${C.sand}; }
.summary { background: #${C.soft}; border-left: 4px solid #${C.clay}; padding: 14px 18px; border-radius: 0 10px 10px 0; margin: 0 0 22px; }
.summary b { color: #${C.rust}; display: block; font-size: 8.5pt; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 4px; }
h2 { font-family: Georgia, serif; font-size: 17pt; color: #${C.ink}; margin: 26px 0 8px; padding-bottom: 6px; border-bottom: 2px solid #${C.sand}; break-after: avoid; }
h3 { font-size: 12.5pt; color: #${C.rust}; margin: 18px 0 6px; break-after: avoid; }
h4, h5 { font-size: 11pt; margin: 14px 0 4px; }
h2 + h3 { margin-top: 10px; }
p { margin: 0 0 10px; }
a { color: #${C.rust}; }
ul, ol { margin: 0 0 12px; padding-left: 22px; } li { margin: 3px 0; } li.d1 { margin-left: 18px; } li.d2 { margin-left: 36px; }
ul li::marker { color: #${C.clay}; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 16px; font-size: 9.8pt; break-inside: avoid; }
th { background: #${C.ink}; color: #${C.paper}; text-align: left; padding: 7px 9px; font-weight: 600; }
td { padding: 6px 9px; border-bottom: 1px solid #${C.line}; vertical-align: top; }
tr:nth-child(even) td { background: #${C.soft}; }
blockquote { margin: 10px 0 14px; padding: 8px 16px; border-left: 3px solid #${C.sand}; color: #${C.muted}; font-style: italic; }
pre { background: #${C.ink}; color: #${C.paper}; padding: 12px 14px; border-radius: 8px; font-size: 9pt; white-space: pre-wrap; }
code { font-family: Consolas, monospace; font-size: .92em; background: #${C.soft}; padding: 1px 4px; border-radius: 4px; } pre code { background: none; padding: 0; }
hr { border: 0; border-top: 1px solid #${C.line}; margin: 18px 0; }
.sources { margin-top: 30px; font-size: 9pt; color: #${C.muted}; } .sources h2 { font-size: 13pt; }
.sources ol { padding-left: 20px; } .sources li { word-break: break-all; }
.foot { margin-top: 34px; font-size: 8pt; color: #${C.muted}; display: flex; justify-content: space-between; border-top: 1px solid #${C.line}; padding-top: 8px; }
</style></head><body><div class="wrap">
<div class="cover"><div class="kind">${esc(doc.kind || 'Research report')}</div><h1>${esc(doc.title)}</h1>${doc.subtitle ? `<div class="sub">${esc(doc.subtitle)}</div>` : ''}<div class="meta">Prepared by Orbit · ${esc(date)}</div></div>
${doc.summary ? `<div class="summary"><b>In short</b>${inlineHtml(doc.summary)}</div>` : ''}
${body}
${sources.length ? `<div class="sources"><h2>Sources</h2><ol>${sources.map(s => `<li><a href="${esc(s)}">${esc(s)}</a></li>`).join('')}</ol></div>` : ''}
<div class="foot"><span>${esc(doc.title)}</span><span>Orbit</span></div>
</div></body></html>`;
}

// ---------- plain text / markdown / csv ----------
function toMarkdown(doc) {
  let s = `# ${doc.title}\n\n`;
  if (doc.subtitle) s += `_${doc.subtitle}_\n\n`;
  if (doc.summary) s += `> ${doc.summary}\n\n`;
  s += String(doc.content || '').trim() + '\n';
  if ((doc.sources || []).length) s += `\n## Sources\n\n${doc.sources.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n`;
  return s;
}
function toText(doc) {
  const out = [doc.title.toUpperCase(), '='.repeat(Math.min(60, doc.title.length))];
  if (doc.subtitle) out.push(doc.subtitle);
  if (doc.summary) out.push('', 'In short: ' + plain(doc.summary));
  for (const b of parse(doc.content)) {
    if (b.t === 'h') out.push('', b.level <= 1 ? plain(b.text).toUpperCase() : plain(b.text), b.level <= 2 ? '-'.repeat(Math.min(60, b.text.length)) : '');
    else if (b.t === 'p') out.push(plain(b.text), '');
    else if (b.t === 'list') { b.items.forEach((it, k) => out.push(`${'  '.repeat(it.depth)}${b.ordered ? (k + 1) + '.' : '•'} ${plain(it.text)}`)); out.push(''); }
    else if (b.t === 'table') { const w = b.head.map((h, c) => Math.min(40, Math.max(plain(h).length, ...b.rows.map(r => plain(r[c] || '').length)))); const line = (r) => r.map((x, c) => plain(x || '').slice(0, 40).padEnd(w[c])).join('  '); out.push(line(b.head), w.map(n => '-'.repeat(n)).join('  '), ...b.rows.map(line), ''); }
    else if (b.t === 'quote') out.push('  "' + plain(b.text) + '"', '');
    else if (b.t === 'code') out.push(b.text, '');
  }
  if ((doc.sources || []).length) out.push('', 'SOURCES', ...doc.sources.map((u, i) => `${i + 1}. ${u}`));
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}
function toCsv(doc) {
  const q = (v) => { const s = plain(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  if (Array.isArray(doc.rows) && doc.rows.length) return doc.rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
  const t = parse(doc.content).find(b => b.t === 'table');
  if (!t) throw new Error('A CSV needs a markdown table in content, or rows.');
  return [t.head, ...t.rows].map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
}

// ---------- DOCX (hand-built OOXML, zipped with JSZip) ----------
const x = (s) => esc(s).replace(/'/g, '&apos;');
function docxRuns(s, extra = '') {
  return runs(s).map(r => {
    const pr = `${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ''}${r.link ? `<w:color w:val="${C.rust}"/><w:u w:val="single"/>` : ''}${extra}`;
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`;
  }).join('');
}
async function toDocx(doc) {
  const JSZip = require('jszip');
  const P = (style, inner, ppr = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${ppr}</w:pPr>${inner}</w:p>`;
  let body = P('Title', docxRuns(doc.title));
  if (doc.subtitle) body += P('Subtitle', docxRuns(doc.subtitle));
  if (doc.summary) body += P('Summary', docxRuns(doc.summary));
  for (const b of parse(doc.content)) {
    if (b.t === 'h') body += P(`Heading${Math.min(3, b.level <= 1 ? 1 : b.level - 1)}`, docxRuns(b.text));
    else if (b.t === 'p') body += P('', docxRuns(b.text));
    else if (b.t === 'list') b.items.forEach(it => { body += P('ListParagraph', docxRuns(it.text), `<w:numPr><w:ilvl w:val="${it.depth}"/><w:numId w:val="${b.ordered ? 2 : 1}"/></w:numPr>`); });
    else if (b.t === 'quote') body += P('Quote', docxRuns(b.text));
    else if (b.t === 'code') body += b.text.split('\n').map(l => P('Code', `<w:r><w:t xml:space="preserve">${x(l)}</w:t></w:r>`)).join('');
    else if (b.t === 'table') {
      const cell = (t, head) => `<w:tc><w:tcPr>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="${C.ink}"/>` : ''}</w:tcPr>${P('', docxRuns(t, head ? `<w:b/><w:color w:val="${C.paper}"/>` : ''))}</w:tc>`;
      body += `<w:tbl><w:tblPr><w:tblStyle w:val="OrbitTable"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${`<w:tr>${b.head.map(h => cell(h, true)).join('')}</w:tr>`}${b.rows.map(r => `<w:tr>${b.head.map((_, k) => cell(r[k] || '', false)).join('')}</w:tr>`).join('')}</w:tbl>` + P('', '');
    } else if (b.t === 'hr') body += P('', '', `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${C.line}"/></w:pBdr>`);
  }
  if ((doc.sources || []).length) { body += P('Heading1', docxRuns('Sources')); doc.sources.forEach(s => { body += P('ListParagraph', docxRuns(s), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'); }); }
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  const st = (id, name, rpr, ppr = '', based = 'Normal') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="${based}"/><w:qFormat/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
  z.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI"/><w:sz w:val="21"/><w:color w:val="${C.ink}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${st('Title', 'Title', `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="56"/><w:color w:val="${C.ink}"/>`, `<w:spacing w:after="80"/><w:pBdr><w:bottom w:val="single" w:sz="24" w:space="6" w:color="${C.clay}"/></w:pBdr>`)}${st('Subtitle', 'Subtitle', `<w:sz w:val="26"/><w:color w:val="${C.muted}"/>`, '<w:spacing w:after="240"/>')}${st('Summary', 'Summary', `<w:i/><w:color w:val="${C.rust}"/>`, `<w:shd w:val="clear" w:color="auto" w:fill="${C.soft}"/><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${C.clay}"/></w:pBdr><w:spacing w:after="240"/>`)}${st('Heading1', 'heading 1', `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="34"/><w:color w:val="${C.ink}"/>`, `<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="2" w:color="${C.sand}"/></w:pBdr><w:outlineLvl w:val="0"/>`)}${st('Heading2', 'heading 2', `<w:b/><w:sz w:val="26"/><w:color w:val="${C.rust}"/>`, '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/>')}${st('Heading3', 'heading 3', '<w:b/><w:sz w:val="22"/>', '<w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/>')}${st('ListParagraph', 'List Paragraph', '', '<w:spacing w:after="60"/>')}${st('Quote', 'Quote', `<w:i/><w:color w:val="${C.muted}"/>`, `<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="${C.sand}"/></w:pBdr>`)}${st('Code', 'Code', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>', `<w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="${C.soft}"/>`)}<w:style w:type="table" w:styleId="OrbitTable"><w:name w:val="Orbit Table"/><w:tblPr><w:tblBorders><w:bottom w:val="single" w:sz="4" w:color="${C.line}"/><w:insideH w:val="single" w:sz="4" w:color="${C.line}"/></w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`);
  const lvl = (ordered) => [0, 1, 2].map(l => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? `%${l + 1}.` : '•'}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 + l * 360}" w:hanging="260"/></w:pPr>${ordered ? '' : `<w:rPr><w:color w:val="${C.clay}"/></w:rPr>`}</w:lvl>`).join('');
  z.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0">${lvl(false)}</w:abstractNum><w:abstractNum w:abstractNumId="1">${lvl(true)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`);
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- PPTX (pptxgenjs) ----------
async function toPptx(doc) {
  const PptxGen = require('pptxgenjs');
  const p = new PptxGen(); p.layout = 'LAYOUT_WIDE'; p.title = doc.title; p.author = 'Orbit';
  const W = 13.333; const F = 'Segoe UI'; const SERIF = 'Georgia';
  // cover
  const cover = p.addSlide(); cover.background = { color: C.ink };
  cover.addShape(p.ShapeType.ellipse, { x: 9.6, y: -1.6, w: 5, h: 5, line: { color: C.clay, width: 28 }, fill: { type: 'none' } });
  cover.addText((doc.kind || 'Research report').toUpperCase(), { x: 0.8, y: 2.2, w: 8, h: 0.4, fontFace: F, fontSize: 12, bold: true, color: C.sand, charSpacing: 4 });
  cover.addText(doc.title, { x: 0.8, y: 2.7, w: 9.2, h: 1.9, fontFace: SERIF, fontSize: 40, color: C.paper, valign: 'top', fit: 'shrink' });
  if (doc.subtitle) cover.addText(doc.subtitle, { x: 0.8, y: 4.7, w: 9, h: 0.8, fontFace: F, fontSize: 16, color: C.line });
  cover.addText(`Prepared by Orbit · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, { x: 0.8, y: 6.6, w: 8, h: 0.4, fontFace: F, fontSize: 11, color: C.sand });
  // sections -> slides (each ## or # starts one); summary first
  const blocks = parse(doc.content);
  const slides = [];
  if (doc.summary) slides.push({ title: 'In short', blocks: [{ t: 'p', text: doc.summary }], big: true });
  let cur = null;
  for (const b of blocks) {
    if (b.t === 'h' && b.level <= 2) { cur = { title: plain(b.text), blocks: [] }; slides.push(cur); continue; }
    if (!cur) { cur = { title: doc.title, blocks: [] }; slides.push(cur); }
    cur.blocks.push(b);
  }
  let n = 0;
  for (const sl of slides) {
    // split long slides: tables get their own slide, text over ~9 lines continues
    const parts = []; let buf = []; let lines = 0;
    for (const b of sl.blocks) {
      if (b.t === 'table') { if (buf.length) parts.push(buf); parts.push([b]); buf = []; lines = 0; continue; }
      const cost = b.t === 'list' ? b.items.length : b.t === 'p' ? Math.ceil(plain(b.text).length / 110) : 1;
      if (lines + cost > 10 && buf.length) { parts.push(buf); buf = []; lines = 0; }
      buf.push(b); lines += cost;
    }
    if (buf.length || !parts.length) parts.push(buf);
    parts.forEach((part, k) => {
      n++;
      const s = p.addSlide(); s.background = { color: 'FFFFFF' };
      s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: C.clay }, line: { color: C.clay } });
      s.addText(sl.title + (k ? ' (cont.)' : ''), { x: 0.7, y: 0.45, w: W - 1.4, h: 0.9, fontFace: SERIF, fontSize: 28, color: C.ink, fit: 'shrink' });
      s.addShape(p.ShapeType.line, { x: 0.72, y: 1.38, w: 1.4, h: 0, line: { color: C.sand, width: 3 } });
      s.addText(`${n}`, { x: W - 1.1, y: 6.85, w: 0.6, h: 0.35, fontFace: F, fontSize: 10, color: C.muted, align: 'right' });
      s.addText('Orbit', { x: 0.7, y: 6.85, w: 3, h: 0.35, fontFace: F, fontSize: 10, color: C.muted });
      const tbl = part.find(b => b.t === 'table');
      if (tbl) {
        const head = tbl.head.map(h => ({ text: plain(h), options: { bold: true, color: C.paper, fill: { color: C.ink } } }));
        const rows = tbl.rows.slice(0, 12).map((r, ri) => tbl.head.map((_, c) => ({ text: plain(r[c] || ''), options: { fill: { color: ri % 2 ? C.soft : 'FFFFFF' } } })));
        s.addTable([head, ...rows], { x: 0.7, y: 1.7, w: W - 1.4, fontFace: F, fontSize: tbl.rows.length > 8 ? 11 : 15, rowH: tbl.rows.length > 8 ? 0.36 : 0.5, color: C.ink, border: { type: 'solid', pt: 0.5, color: C.line }, autoPage: false });
        return;
      }
      const textRuns = [];
      for (const b of part) {
        const add = (txt, o = {}) => { const rr = runs(txt); rr.forEach((r, ri) => textRuns.push({ text: r.text, options: { bold: r.b || o.bold, italic: r.i || o.italic, color: r.link ? C.rust : (o.color || C.ink), fontFace: r.code ? 'Consolas' : F, ...(r.link ? { hyperlink: { url: r.link } } : {}), ...(ri === rr.length - 1 ? { breakLine: true } : {}), ...(ri === 0 ? o.para || {} : {}) } })); };
        if (b.t === 'p') add(b.text, { para: { paraSpaceAfter: 8 } });
        else if (b.t === 'list') b.items.forEach((it) => textRuns.push({ text: plain(it.text), options: { color: C.ink, fontFace: F, breakLine: true, bullet: b.ordered ? { type: 'number' } : { code: '25CF', color: C.clay }, indentLevel: it.depth, paraSpaceAfter: 6 } })); // one run per bullet: pptxgenjs splits runs that carry bullets
        else if (b.t === 'h') add(b.text, { bold: true, color: C.rust, para: { paraSpaceBefore: 6 } });
        else if (b.t === 'quote') add(b.text, { italic: true, color: C.muted });
        else if (b.t === 'code') add('`' + b.text.slice(0, 400).replace(/`/g, "'") + '`', { para: { paraSpaceBefore: 4 } });
      }
      if (textRuns.length) s.addText(textRuns, { x: 0.7, y: 1.65, w: W - 1.4, h: 5.0, fontSize: sl.big ? 26 : 20, valign: 'top', fit: 'shrink' });
    });
  }
  if ((doc.sources || []).length) {
    const s = p.addSlide(); s.background = { color: C.ink };
    s.addText('Sources', { x: 0.7, y: 0.5, w: 10, h: 0.8, fontFace: SERIF, fontSize: 28, color: C.paper });
    s.addText(doc.sources.slice(0, 14).map((u, i) => ({ text: `${i + 1}. ${u}`, options: { breakLine: true, hyperlink: { url: u }, color: C.sand } })), { x: 0.7, y: 1.5, w: W - 1.4, h: 5.4, fontFace: F, fontSize: 12, valign: 'top', fit: 'shrink' });
  }
  return p.write({ outputType: 'nodebuffer' });
}

// ---------- PDF (Electron renders the HTML) ----------
async function toPdf(doc) {
  const { BrowserWindow } = require('electron');
  const tmp = path.join(os.tmpdir(), `orbit-doc-${Date.now().toString(36)}.html`);
  fs.writeFileSync(tmp, toHtml(doc));
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: true } });
  try {
    await win.loadFile(tmp);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'custom', top: 0.5, bottom: 0.55, left: 0.45, right: 0.45 }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#${C.muted};font-family:Segoe UI,sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>` });
  } finally { win.destroy(); fs.rm(tmp, () => {}); }
}

async function render(doc) {
  const format = String(doc.format || 'pdf').toLowerCase().replace(/^\./, '').replace('markdown', 'md').replace('text', 'txt').replace('powerpoint', 'pptx').replace('word', 'docx');
  if (!FORMATS.includes(format)) throw new Error(`Format must be one of: ${FORMATS.join(', ')}.`);
  if (!doc.title) throw new Error('Give the file a title.');
  doc.sources = (Array.isArray(doc.sources) ? doc.sources : String(doc.sources || '').split(/\s+/)).map(s => String(s).trim()).filter(s => /^https?:\/\//.test(s));
  let data;
  if (format === 'html') data = toHtml(doc);
  else if (format === 'md') data = toMarkdown(doc);
  else if (format === 'txt') data = toText(doc);
  else if (format === 'csv') data = toCsv(doc);
  else if (format === 'docx') data = await toDocx(doc);
  else if (format === 'pptx') data = await toPptx(doc);
  else data = await toPdf(doc);
  return { format, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') };
}

module.exports = { render, parse, toHtml, toText, toMarkdown, toCsv, toDocx, toPptx, FORMATS };
