// Orbiter scene themes: an illustrated backdrop behind the conversation plus a matching palette.
// Everything is drawn here in SVG (no downloads, no third-party art), so they work offline.
(function () {
  const rnd = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const stars = (n, w, h, seed, cls = 'tw') => { const r = rnd(seed); let s = ''; for (let i = 0; i < n; i++) { const x = r() * w, y = r() * h, rad = r() * 1.3 + 0.3; s += `<circle class="${r() > 0.6 ? cls : ''}" style="animation-delay:${(r() * 4).toFixed(2)}s" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(2)}" fill="#fff" opacity="${(r() * 0.6 + 0.3).toFixed(2)}"/>`; } return s; };
  const windows = (x0, y0, cols, rows, seed, lit = '#f2b95c') => { const r = rnd(seed); let s = ''; for (let c = 0; c < cols; c++) for (let k = 0; k < rows; k++) if (r() > 0.42) s += `<rect x="${x0 + c * 16}" y="${y0 + k * 22}" width="7" height="11" fill="${lit}" opacity="${(r() * 0.5 + 0.5).toFixed(2)}"/>`; return s; };

  // ---------- Paris at night ----------
  const eiffel = (() => {
    let lattice = '';
    for (let y = 120; y < 640; y += 9) { const half = 6 + Math.pow((y - 120) / 520, 2.1) * 120; lattice += `<line x1="${800 - half}" y1="${y}" x2="${800 + half}" y2="${y}"/>`; }
    for (let i = -6; i <= 6; i++) lattice += `<line x1="${800 + i * 1.2}" y1="120" x2="${800 + i * 21}" y2="640"/>`;
    return `<g stroke="#f0b04a" stroke-width=".9" opacity=".85" clip-path="url(#pTower)">${lattice}</g>
      <clipPath id="pTower"><path d="M796 92h8l3 40c4 120 18 230 44 330l10 40h-18l-6-28c-18-14-44-14-62 0l-6 28h-18l10-40c26-100 40-210 44-330z M736 640c10-60 28-104 64-128 36 24 54 68 64 128z"/></clipPath>
      <path d="M800 70v26" stroke="#f6c66b" stroke-width="2"/><circle cx="800" cy="68" r="3" fill="#ffe2a0"/>
      <rect x="770" y="452" width="60" height="7" fill="#f0b04a" opacity=".9"/><rect x="782" y="300" width="36" height="5" fill="#f0b04a" opacity=".9"/>`;
  })();
  const paris = `<svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="pSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070a1c"/><stop offset=".6" stop-color="#131a43"/><stop offset="1" stop-color="#2a2a5e"/></linearGradient>
      <radialGradient id="pMoon"><stop offset="0" stop-color="#fffbe8" stop-opacity=".55"/><stop offset="1" stop-color="#fffbe8" stop-opacity="0"/></radialGradient>
      <linearGradient id="pBeam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff6d6" stop-opacity=".45"/><stop offset="1" stop-color="#fff6d6" stop-opacity="0"/></linearGradient>
      <radialGradient id="pGlow" cx=".8" cy=".95" r=".5"><stop offset="0" stop-color="#f0a040" stop-opacity=".22"/><stop offset="1" stop-color="#f0a040" stop-opacity="0"/></radialGradient></defs>
    <rect width="1000" height="700" fill="url(#pSky)"/><rect width="1000" height="700" fill="url(#pGlow)"/>
    <g>${stars(120, 1000, 420, 7)}</g>
    <circle cx="110" cy="110" r="90" fill="url(#pMoon)"/><circle cx="110" cy="110" r="28" fill="#fdf6dc"/><circle cx="101" cy="102" r="5" fill="#ece2bf"/><circle cx="120" cy="118" r="3.5" fill="#ece2bf"/>
    <g class="sweep" style="transform-origin:800px 98px"><path d="M800 96 L1000 60 L1000 132 Z" fill="url(#pBeam)"/></g>
    ${eiffel}
    <g fill="#0b0d22"><path d="M0 560h40l10-20h50l10 20h30v-60h18l12-26 12 26h18v40h60l14-24h60l14 24h30v160H0z"/><path d="M380 600h70l12-18h60l12 18h40v100H380z"/></g>
    <g>${windows(14, 572, 5, 5, 3)}${windows(160, 512, 4, 8, 11)}${windows(250, 552, 6, 6, 17)}${windows(394, 612, 9, 4, 29)}</g>
    <g fill="#0b0d22"><rect x="62" y="520" width="6" height="22"/><rect x="230" y="525" width="6" height="18"/></g>
  </svg>`;

  // ---------- Mount Fuji at dusk ----------
  const fuji = `<svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="fSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14112b"/><stop offset=".45" stop-color="#3b2550"/><stop offset=".75" stop-color="#b65a62"/><stop offset="1" stop-color="#f0a47a"/></linearGradient>
      <linearGradient id="fMt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d3a63"/><stop offset="1" stop-color="#1c1a33"/></linearGradient></defs>
    <rect width="1000" height="700" fill="url(#fSky)"/>
    <g>${stars(70, 1000, 260, 41)}</g>
    <circle cx="760" cy="470" r="70" fill="#ffcf9a" opacity=".9"/><circle cx="760" cy="470" r="120" fill="#ffcf9a" opacity=".12"/>
    <path d="M330 700 L620 300 Q660 280 700 300 L1000 640 L1000 700Z" fill="url(#fMt)"/>
    <path d="M620 300 Q660 280 700 300 L742 348 L722 340 L706 356 L688 336 L668 352 L650 334 L632 350 L612 336 L590 344Z" fill="#f4eef6"/>
    <path d="M0 610 Q160 560 320 600 T640 610 T1000 600 V700H0Z" fill="#241c37"/>
    <path d="M0 650 Q200 620 420 655 T1000 650 V700H0Z" fill="#140f22"/>
    <g fill="#140f22"><rect x="120" y="520" width="8" height="120"/><rect x="190" y="520" width="8" height="120"/><rect x="104" y="512" width="110" height="10" rx="3"/><rect x="112" y="536" width="94" height="6"/></g>
    <g fill="#e7849b" opacity=".75">${(() => { const r = rnd(5); let s = ''; for (let i = 0; i < 26; i++) s += `<ellipse class="petal" style="animation-delay:${(r() * 8).toFixed(1)}s" cx="${(r() * 1000).toFixed(0)}" cy="${(r() * 500).toFixed(0)}" rx="3" ry="2"/>`; return s; })()}</g>
  </svg>`;

  // ---------- Racing red (a generic open-wheel car, no team marks) ----------
  const racing = `<svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="rBg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#120405"/><stop offset=".5" stop-color="#0a0a0b"/><stop offset="1" stop-color="#160506"/></linearGradient>
      <linearGradient id="rBody" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#9e0d12"/><stop offset=".5" stop-color="#e3171d"/><stop offset="1" stop-color="#9e0d12"/></linearGradient></defs>
    <rect width="1000" height="700" fill="url(#rBg)"/>
    <g stroke="#e3171d" stroke-opacity=".07" stroke-width="2">${Array.from({ length: 30 }, (_, i) => `<line x1="${i * 36}" y1="0" x2="${i * 36 - 200}" y2="700"/>`).join('')}</g>
    <text x="70" y="430" font-family="Segoe UI, sans-serif" font-weight="800" font-size="300" fill="#e3171d" opacity=".09" font-style="italic">16</text>
    <g transform="translate(855 350)">
      <rect x="-80" y="-298" width="160" height="26" rx="4" fill="#1a1a1a"/><rect x="-80" y="-286" width="160" height="10" fill="#e3171d"/>
      <rect x="-92" y="-205" width="34" height="72" rx="10" fill="#151515"/><rect x="58" y="-205" width="34" height="72" rx="10" fill="#151515"/>
      <rect x="-98" y="140" width="40" height="86" rx="12" fill="#151515"/><rect x="58" y="140" width="40" height="86" rx="12" fill="#151515"/>
      <path d="M-14 -280 C-14 -240 -22 -200 -26 -150 L-58 -40 L-62 120 L-40 210 L40 210 L62 120 L58 -40 L26 -150 C22 -200 14 -240 14 -280Z" fill="url(#rBody)"/>
      <path d="M-62 -10 L-74 120 L-58 150 L-48 -6Z M62 -10 L74 120 L58 150 L48 -6Z" fill="#c11319"/>
      <ellipse cx="0" cy="-20" rx="20" ry="34" fill="#0d0d0d"/><circle cx="0" cy="-24" r="12" fill="#f2f2f2"/><circle cx="0" cy="-24" r="12" fill="none" stroke="#e3171d" stroke-width="3"/>
      <path d="M-24 -52 Q0 -78 24 -52" stroke="#2b2b2b" stroke-width="5" fill="none"/>
      <rect x="-88" y="208" width="176" height="30" rx="4" fill="#1a1a1a"/><rect x="-88" y="220" width="176" height="8" fill="#e3171d"/>
      <rect x="-6" y="40" width="12" height="150" fill="#fff" opacity=".85"/>
    </g>
    <g opacity=".5">${Array.from({ length: 14 }, (_, i) => `<rect x="${i * 20}" y="676" width="10" height="10" fill="#fff"/><rect x="${i * 20 + 10}" y="686" width="10" height="10" fill="#fff"/>`).join('')}</g>
  </svg>`;

  // ---------- Retro 95 desktop ----------
  const icon = (x, y, label, art) => `<g transform="translate(${x} ${y})">${art}<text x="24" y="62" text-anchor="middle" font-family="Tahoma, MS Sans Serif, sans-serif" font-size="11" fill="#fff">${label}</text></g>`;
  const retro = `<svg viewBox="0 0 1000 700" preserveAspectRatio="xMinYMin slice" xmlns="http://www.w3.org/2000/svg">
    <rect width="1000" height="700" fill="#008080"/>
    ${icon(20, 20, 'My Computer', '<rect x="6" y="2" width="36" height="28" fill="#c0c0c0" stroke="#000"/><rect x="11" y="6" width="26" height="19" fill="#000080"/><rect x="2" y="32" width="44" height="12" fill="#c0c0c0" stroke="#000"/>')}
    ${icon(20, 100, 'Recycle Bin', '<path d="M10 10h28l-4 34H14z" fill="#e0e0e0" stroke="#000"/><path d="M8 8h32" stroke="#000" stroke-width="3"/><path d="M18 16v22M24 16v22M30 16v22" stroke="#808080"/>')}
    ${icon(20, 180, 'Orbit', '<circle cx="24" cy="22" r="14" fill="#c4673a" stroke="#000"/><ellipse cx="24" cy="22" rx="22" ry="7" fill="none" stroke="#ffd25a" stroke-width="2"/>')}
    ${icon(20, 260, 'Projects', '<path d="M4 12h14l4 5h22v25H4z" fill="#ffd25a" stroke="#000"/>')}
  </svg>`;

  // ---------- Snowfall ----------
  const snow = `<svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06131a"/><stop offset="1" stop-color="#0f2a33"/></linearGradient></defs>
    <rect width="1000" height="700" fill="url(#sSky)"/>
    <g>${stars(60, 1000, 300, 13)}</g>
    <path class="lights" d="M0 30 Q125 80 250 30 T500 30 T750 30 T1000 30" stroke="#2c3b2f" stroke-width="2" fill="none"/>
    <g>${Array.from({ length: 21 }, (_, i) => { const x = i * 50, t = (x % 250) / 250, y = 30 + Math.sin(t * Math.PI) * 25; const c = ['#ff5a4f', '#ffd25a', '#4fd3a6', '#6aa8ff'][i % 4]; return `<circle class="tw" style="animation-delay:${(i % 5) * 0.6}s" cx="${x}" cy="${y + 6}" r="5" fill="${c}"/>`; }).join('')}</g>
    <g transform="translate(850 690)">
      <path d="M0 -430 L-70 -300 L-40 -300 L-110 -180 L-70 -180 L-150 -40 L150 -40 L70 -180 L110 -180 L40 -300 L70 -300Z" fill="#14462f"/>
      <rect x="-16" y="-40" width="32" height="40" fill="#4a2f1d"/>
      <path d="M0 -452 l7 15 16 2 -12 11 3 16 -14 -8 -14 8 3 -16 -12 -11 16 -2z" fill="#ffd25a"/>
      ${Array.from({ length: 16 }, (_, i) => { const r = rnd(i + 3); const y = -380 + i * 22; const w = 30 + (i * 7); return `<circle class="tw" style="animation-delay:${(r() * 3).toFixed(1)}s" cx="${((r() - 0.5) * w * 1.6).toFixed(0)}" cy="${y}" r="6" fill="${['#ff5a4f', '#ffd25a', '#f4f4f4', '#6aa8ff'][i % 4]}"/>`; }).join('')}
    </g>
    <path d="M0 676 Q250 656 500 676 T1000 670 V700H0Z" fill="#cfdde2" opacity=".55"/>
    <g fill="#fff">${(() => { const r = rnd(99); let s = ''; for (let i = 0; i < 90; i++) s += `<circle class="flake" style="animation-delay:-${(r() * 12).toFixed(1)}s;animation-duration:${(8 + r() * 8).toFixed(1)}s" cx="${(r() * 1000).toFixed(0)}" cy="-10" r="${(r() * 2.4 + 0.8).toFixed(1)}" opacity="${(r() * 0.6 + 0.4).toFixed(2)}"/>`; return s; })()}</g>
  </svg>`;

  // ---------- Orbit nebula (the brand theme) ----------
  const nebula = `<svg viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="nA" cx=".85" cy=".2" r=".6"><stop offset="0" stop-color="#c4673a" stop-opacity=".35"/><stop offset="1" stop-color="#c4673a" stop-opacity="0"/></radialGradient>
      <radialGradient id="nB" cx=".1" cy=".9" r=".6"><stop offset="0" stop-color="#7a3a8c" stop-opacity=".25"/><stop offset="1" stop-color="#7a3a8c" stop-opacity="0"/></radialGradient>
      <radialGradient id="nP" cx=".35" cy=".35"><stop offset="0" stop-color="#f3c08f"/><stop offset=".6" stop-color="#c4673a"/><stop offset="1" stop-color="#5a2412"/></radialGradient></defs>
    <rect width="1000" height="700" fill="#0c0b0a"/><rect width="1000" height="700" fill="url(#nA)"/><rect width="1000" height="700" fill="url(#nB)"/>
    <g>${stars(160, 1000, 700, 23)}</g>
    <g transform="translate(860 170)"><g class="spin"><ellipse rx="150" ry="44" fill="none" stroke="#e4a270" stroke-opacity=".35" stroke-width="1.5" transform="rotate(-18)"/><circle cx="142" cy="-46" r="5" fill="#ffd9b0"/></g>
      <circle r="58" fill="url(#nP)"/><ellipse rx="96" ry="18" fill="none" stroke="#e4a270" stroke-width="5" stroke-opacity=".75" transform="rotate(-18)"/></g>
    <circle cx="140" cy="600" r="16" fill="#ae4e27" opacity=".8"/><circle cx="140" cy="600" r="40" fill="none" stroke="#e4a270" stroke-opacity=".15"/>
    <path class="comet" d="M-60 120 L80 180" stroke="#fff" stroke-opacity=".5" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;

  window.ORBITER_BACKDROPS = [
    { id: 'scene:orbit-nebula', name: 'Orbit Nebula', base: 'orbit-dark', svg: nebula, overrides: { bg: '#0c0b0a', panel: 'rgba(22,20,18,.82)' } },
    { id: 'scene:paris-night', name: 'Paris at Night', base: 'midnight', svg: paris, overrides: { bg: '#0b0e24', panel: 'rgba(12,15,38,.86)', raised: 'rgba(28,33,72,.82)', hover: 'rgba(48,56,110,.6)', accent: '#f0b04a', accent2: '#ffd48a', 'accent-deep': '#c98a2a', 'accent-soft': 'rgba(240,176,74,.16)', 'code-bg': 'rgba(5,7,20,.85)' } },
    { id: 'scene:mount-fuji', name: 'Mount Fuji', base: 'orbit-dark', svg: fuji, overrides: { bg: '#1a1530', panel: 'rgba(24,19,42,.84)', raised: 'rgba(46,36,74,.82)', hover: 'rgba(80,60,110,.55)', accent: '#e7849b', accent2: '#ffc0cf', 'accent-deep': '#c25d77', 'accent-soft': 'rgba(231,132,155,.16)', 'code-bg': 'rgba(12,9,24,.85)' } },
    { id: 'scene:racing-red', name: 'Racing Red', base: 'orbit-dark', svg: racing, overrides: { bg: '#0a0a0b', panel: 'rgba(14,12,12,.88)', raised: 'rgba(30,24,24,.85)', hover: 'rgba(60,20,22,.6)', accent: '#e3171d', accent2: '#ff5a5f', 'accent-deep': '#a90f14', 'accent-soft': 'rgba(227,23,29,.15)', 'code-bg': 'rgba(4,4,4,.88)' } },
    { id: 'scene:snowfall', name: 'Snowfall', base: 'orbit-dark', svg: snow, overrides: { bg: '#081820', panel: 'rgba(8,24,30,.86)', raised: 'rgba(18,44,52,.84)', hover: 'rgba(30,70,80,.55)', accent: '#ff5a4f', accent2: '#ffd25a', 'accent-deep': '#c9362c', 'accent-soft': 'rgba(255,90,79,.15)', 'code-bg': 'rgba(4,14,18,.86)' } },
    { id: 'scene:retro-95', name: 'Retro 95', base: 'orbit-light', svg: retro, cls: 'retro95', overrides: { bg: '#008080', panel: '#c0c0c0', raised: '#ffffff', hover: '#dcdcdc', line: '#808080', line2: '#808080', text: '#000000', dim: '#202020', faint: '#505050', accent: '#000080', accent2: '#000080', 'accent-deep': '#00005a', 'accent-soft': 'rgba(0,0,128,.12)', 'code-bg': '#ffffff', add: '#006400', del: '#a00000' } },
  ];
})();
