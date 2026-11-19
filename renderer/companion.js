// Orbit — Companion view: an anime avatar beside the chat whose lips move with the voice.
//   OrbitCompanion.setEnabled(on)      turn the view on or off (Settings → Look → Interface)
//   OrbitCompanion.onAudioNode(node)   tap a Web Audio node that carries the assistant's voice (read-aloud, live calls)
//   OrbitCompanion.speakingStart/End() hint that speech without an audio node is playing (speechSynthesis)
//   OrbitCompanion.boundary()          a word started (speechSynthesis boundary event): open the mouth
//   OrbitCompanion.react(text)         a finished reply; a clearly happy one gets a short laugh
// Mouth frames come from the real audio level when there is a node to read (RMS → neutral/e/o/a at about
// 14 fps, lightly smoothed). The Windows voice gives no audio access, so it gets a timed mouth cycle
// nudged by word boundaries for as long as speechSynthesis is speaking.
(function () {
  const FRAMES = ['neutral', 'a', 'o', 'e', 'blink', 'laugh'];
  const TICK = 70; // ms, about 14 fps
  let enabled = false, timer = 0, taps = [], hint = 0, forced = null;
  let level = 0, lastAudio = 0, lastSwap = 0, frame = 'neutral', speaking = false;
  let nextBlink = 0, blinkUntil = 0, laughUntil = 0, laughPending = false, kick = 0;
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $$ = (s) => [...document.querySelectorAll(s)];

  // Decode every frame up front so the first swap never shows a blank.
  const preloaded = FRAMES.map(f => { const i = new Image(); i.src = `companion/${f}.png`; i.decode && i.decode().catch(() => {}); return i; });

  function onAudioNode(node) {
    try {
      if (!node || !node.context) return () => {};
      const an = node.context.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0.2;
      node.connect(an); // an analyser needs no output: it is read, never heard
      const tap = { an, buf: new Float32Array(an.fftSize), ctx: node.context };
      taps.push(tap);
      return () => { taps = taps.filter(t => t !== tap); try { node.disconnect(an); } catch {} };
    } catch { return () => {}; }
  }
  function readLevel() {
    let max = 0;
    taps = taps.filter(t => t.ctx.state !== 'closed');
    for (const t of taps) {
      if (t.ctx.state !== 'running') continue;
      t.an.getFloatTimeDomainData(t.buf);
      let s = 0; for (let i = 0; i < t.buf.length; i++) s += t.buf[i] * t.buf[i];
      max = Math.max(max, Math.sqrt(s / t.buf.length));
    }
    return max;
  }
  const synthSpeaking = () => { try { return typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking && !speechSynthesis.paused; } catch { return false; } };

  function setFrame(f) {
    if (f === frame) return;
    frame = f;
    for (const el of $$('.cmp-avatar')) el.dataset.frame = f;
  }
  function setSpeaking(on) {
    if (on === speaking) return;
    speaking = on;
    for (const el of $$('.companion, .cmp-live')) el.classList.toggle('speaking', on);
    const st = document.getElementById('cmpState');
    if (st) st.textContent = on ? 'Speaking…' : stateText();
  }
  function stateText() {
    if (window.OrbitLive && OrbitLive.on) return 'On a call with you';
    if (document.body.classList.contains('busy')) return 'Working on it…';
    return 'Here with you';
  }
  function bars(v) {
    const bs = $$('.companion .cmp-wave i');
    bs.forEach((b, i) => b.style.setProperty('--l', speaking ? Math.min(1, v * (0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 120 + i * 1.7)))).toFixed(2) : '0'));
  }

  function tick() {
    const now = performance.now();
    if (forced) { setFrame(forced.frame || 'neutral'); setSpeaking(!!forced.speaking); bars(forced.speaking ? 0.85 : 0); return; }
    const raw = readLevel();
    level = level * 0.45 + raw * 0.55; // light smoothing
    if (raw > 0.012) lastAudio = now;
    const audio = now - lastAudio < 260;
    const synth = !audio && (synthSpeaking() || hint > 0);
    setSpeaking(audio || synth);
    if (audio) {
      const f = level < 0.018 ? 'neutral' : level < 0.05 ? 'e' : level < 0.1 ? 'o' : 'a';
      setFrame(f); bars(Math.min(1, level * 7));
      return;
    }
    if (synth) {
      // No audio to read: cycle the mouth like speech, opening wider right after a word starts.
      if (now - lastSwap > 85 + Math.random() * 90) {
        lastSwap = now;
        const fresh = now - kick < 160;
        const pick = fresh ? (Math.random() < 0.6 ? 'a' : 'o') : ['e', 'o', 'a', 'e', 'neutral'][Math.floor(Math.random() * 5)];
        setFrame(pick === frame && pick !== 'neutral' ? 'e' : pick);
      }
      bars(0.35 + Math.random() * 0.45);
      return;
    }
    bars(0);
    // Idle: a laugh after a happy reply, and blinks every 2 to 6 seconds.
    if (laughPending) { laughPending = false; laughUntil = now + 1100; }
    if (now < laughUntil) { setFrame('laugh'); return; }
    if (!nextBlink) nextBlink = now + 2000 + Math.random() * 4000;
    if (now >= nextBlink) { blinkUntil = now + 120; nextBlink = now + 2000 + Math.random() * 4000; }
    setFrame(now < blinkUntil ? 'blink' : 'neutral');
    const st = document.getElementById('cmpState');
    if (st && !speaking) { const t = stateText(); if (st.textContent !== t) st.textContent = t; }
  }

  function setEnabled(on) {
    on = !!on;
    document.body.classList.toggle('companion-on', on);
    if (on === enabled) return;
    enabled = on;
    clearInterval(timer); timer = 0;
    if (on) { nextBlink = 0; timer = setInterval(tick, TICK); tick(); }
    else { setSpeaking(false); setFrame('neutral'); }
  }
  // Pause the loop while the window is hidden (tray); taps keep their nodes.
  document.addEventListener('visibilitychange', () => {
    if (!enabled) return;
    clearInterval(timer); timer = document.visibilityState === 'visible' ? setInterval(tick, TICK) : 0;
  });

  const JOY = /\b(ha(ha)+|lol|lmao|yay|woo+hoo?)\b|😄|😂|😆|🎉|😁|(\bgreat\b[^.?]*!)|(!.*\bgreat\b)/i;
  function react(text) { if (enabled && JOY.test(String(text || '').slice(0, 600))) laughPending = true; }

  window.OrbitCompanion = {
    setEnabled, onAudioNode, react,
    speakingStart() { hint++; },
    speakingEnd() { hint = Math.max(0, hint - 1); },
    boundary() { kick = performance.now(); lastSwap = 0; },
    // For tests and screenshots: hold a frame (and the speaking pill) until called with null.
    debug(state) { forced = state || null; if (!forced) { setSpeaking(false); setFrame('neutral'); } else tick(); },
    get enabled() { return enabled; },
    get frame() { return frame; },
    get speaking() { return speaking; },
    get frames() { return FRAMES.slice(); },
    _preloaded: preloaded,
  };
})();
