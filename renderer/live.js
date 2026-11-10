// Orbit Live voice: the full-screen call. Mic in, Orbit's voice out, you can talk over it any time.
(function () {
  const api = window.orbit;
  const $ = (s) => document.querySelector(s);
  let micCtx = null, micStream = null, micNode = null;
  let playCtx = null, playGain = null, analyser = null, nextTime = 0, sources = [], outEl = null;
  let on = false, muted = false, engine = 'gemini', state = 'idle';
  let micLevel = 0, loudChunks = 0, raf = 0;

  const STATE_TEXT = {
    connecting: 'Connecting…',
    listening: 'Listening',
    speaking: 'Orbit is talking. Jump in anytime.',
    thinking: 'Thinking…',
    working: 'Working on it',
    muted: 'Muted',
    ended: 'Call ended',
  };

  function el() { return $('#live'); }
  // Every connect step has a time limit, so a call can never sit on "Connecting…" forever.
  function within(ms, p, msg) { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); }
  const say = (t) => { if (on) $('#liveStatus').textContent = t; };

  async function start() {
    if (on) return;
    const st = await api.live.status();
    if (!st.ready) {
      window.dispatchEvent(new CustomEvent('orbit-live-needs-setup'));
      return;
    }
    on = true; muted = false; engine = st.engine;
    el().classList.add('open'); el().dataset.state = 'connecting';
    $('#liveYou').textContent = ''; $('#liveOrbit').textContent = '';
    $('#liveMute').classList.remove('on');
    setStatus('connecting');
    let voiceLoad = null;
    if (engine === 'orbit') {
      $('#liveEngine').textContent = 'Orbit Voice · on your laptop';
      const off = OrbitVoice.onStatus((x) => { if (on && x.text) say(x.text); });
      voiceLoad = OrbitVoice.ensure().finally(off);
      voiceLoad.catch((e) => vlog('voice failed to start: ' + (e && e.message || e)));
      // First time the voice downloads for a minute or two: say so out loud right away with the
      // Windows voice, so there's never a silent wait wondering whether sound works at all.
      if (!OrbitVoice.ready) winSayNow("Give me a moment, I'm getting my voice ready.");
    }
    try {
      // Playback first, so the first words are never clipped.
      playCtx = new AudioContext({ sampleRate: 24000 });
      playGain = playCtx.createGain();
      analyser = playCtx.createAnalyser(); analyser.fftSize = 512;
      playGain.connect(analyser);
      // Play through an <audio> element, not straight to the speakers: Chromium's echo canceller only
      // reliably removes sound it plays this way, so Orbit doesn't hear (and interrupt) itself.
      try {
        const dest = playCtx.createMediaStreamDestination(); analyser.connect(dest);
        outEl = new Audio(); outEl.srcObject = dest.stream; await within(3000, outEl.play(), 'audio output did not start');
      } catch { try { analyser.disconnect(); } catch {} analyser.connect(playCtx.destination); outEl = null; }
      nextTime = 0; sources = [];

      say('Starting your microphone…');
      micStream = await within(20000, navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }), "the mic didn't respond. In Windows Settings → Privacy & security → Microphone, turn on access for desktop apps");
      micCtx = new AudioContext({ sampleRate: st.inRate });
      await within(10000, micCtx.audioWorklet.addModule('live-worklet.js'), 'the audio engine didn\'t start');
      micNode = new AudioWorkletNode(micCtx, 'orbit-mic');
      micNode.port.onmessage = (e) => onMic(e.data);
      micCtx.createMediaStreamSource(micStream).connect(micNode);
    } catch (err) {
      fail(`Microphone not available: ${err.message || err}`);
      return;
    }
    if (voiceLoad) {
      if (OrbitVoice.loading) say(OrbitVoice.ready ? '' : 'Getting Orbit\'s voice ready (first time takes a minute or two)…');
      try { await voiceLoad; } catch (err) { fail(`Orbit's voice couldn't start: ${err.message || err}`); return; }
      if (!on) return;
      OrbitVoice.reset(); OrbitVoice.setVoice(st.voice || 'af_heart');
      try { const s = await api.getSettings(); OrbitVoice.setPauseMs(Number(s.orbitPauseMs) || 900); OrbitVoice.setWinVoice(s.orbitWinVoice || ''); OrbitVoice.setPhononVoice(s.orbitPhononVoice || 'Easton'); } catch {}
    }
    if (!on) return;
    say('Connecting…');
    let r;
    try { r = await within(25000, api.live.start(), 'Orbit didn\'t answer. Try again, or restart Orbit'); } catch (err) { fail(err.message); return; }
    if (!on) return;
    if (!r.ok) { fail(r.error); return; }
    engine = r.engine;
    if (engine !== 'orbit') setTimeout(() => { if (on && state === 'connecting') fail(`${engine === 'gemini' ? 'Gemini Live' : 'OpenAI'} didn't pick up. Switch Settings → Live voice to Orbit (built in), which needs no key.`); }, 30000);
    if (engine === 'orbit') setTimeout(() => { if (on) api.voice.opener(); }, 350); // Orbit speaks first
    $('#liveEngine').textContent = engine === 'orbit' ? `Orbit Voice · ${OrbitVoice.windows ? 'Windows voice' : OrbitVoice.engine === 'phonon' ? 'Phonon, on your laptop' : 'on your laptop'}${OrbitVoice.device === 'webgpu' ? ' (GPU)' : ''}` : engine === 'gemini' ? 'Gemini Live' : 'OpenAI GPT-Live';
    loop();
  }

  function onMic({ pcm, rms }) {
    micLevel = micLevel * 0.6 + rms * 0.4;
    if (!on || muted) return;
    if (engine === 'orbit') { OrbitVoice.feed(pcm); return; }
    api.live.audio(pcm);
    // GPT-Live stops talking on its own when you cut in, but audio already queued here would keep
    // playing. If you're clearly speaking over it, drop the queue so it goes quiet at once.
    if (engine === 'openai' && playCtx && nextTime > playCtx.currentTime + 0.25) {
      loudChunks = rms > 0.055 ? loudChunks + 1 : 0;
      if (loudChunks >= 4) { flush(); loudChunks = 0; }
    }
  }

  function play(bytes) {
    if (!playCtx) return;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const n = u8.byteLength >> 1;
    if (!n) return;
    const pcm = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + n * 2));
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = pcm[i] / 0x8000;
    const buf = playCtx.createBuffer(1, n, 24000);
    buf.copyToChannel(f, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buf; src.connect(playGain);
    const t = Math.max(playCtx.currentTime + 0.04, nextTime);
    src.start(t); nextTime = t + buf.duration;
    sources.push(src);
    src.onended = () => { const i = sources.indexOf(src); if (i >= 0) sources.splice(i, 1); };
  }

  function flush() {
    for (const s of sources) { try { s.stop(); } catch {} }
    sources = []; nextTime = 0; sched = []; winSched = [];
    unduck();
    if (engine === 'orbit') { if (window.OrbitVoice && OrbitVoice.windows) OrbitVoice.cancel(); OrbitVoice.setPlaying(false); clearTimeout(playT); }
  }
  // While they might be cutting in, Orbit goes quiet but doesn't stop yet: a cough or a door shouldn't end its sentence.
  let ducked = false;
  function duck() { if (ducked) return; ducked = true; if (window.OrbitVoice && OrbitVoice.windows) OrbitVoice.winPause(); else if (playGain && playCtx) playGain.gain.setTargetAtTime(0.18, playCtx.currentTime, 0.03); }
  function unduck() { if (!ducked) return; ducked = false; if (window.OrbitVoice && OrbitVoice.windows) OrbitVoice.winResume(); else if (playGain && playCtx) playGain.gain.setTargetAtTime(1, playCtx.currentTime, 0.05); }

  // ---------- Orbit Voice: turn-taking, barge-in, backchannels ----------
  let sched = [], playT = 0, waitingSince = 0, fillerT = 0, lastBc = 0, lastSeq = 0, turnSeqs = new Set();
  let winSched = [], barge = false, held = '', heldT = 0, lastSpokenAt = 0;
  function playFloat(f, text, gain = 1) {
    if (!playCtx) return;
    const buf = playCtx.createBuffer(1, f.length, 24000); buf.copyToChannel(f, 0);
    const src = playCtx.createBufferSource(); src.buffer = buf;
    let node = src;
    if (gain !== 1) { const g = playCtx.createGain(); g.gain.value = gain; src.connect(g); node = g; }
    node.connect(playGain);
    const t = Math.max(playCtx.currentTime + 0.03, nextTime);
    src.start(t); nextTime = t + buf.duration;
    sources.push(src); src.onended = () => { const i = sources.indexOf(src); if (i >= 0) sources.splice(i, 1); };
    if (text) sched.push({ start: t, end: nextTime, text });
    OrbitVoice.setPlaying(true); speakingFlag(true);
    clearTimeout(playT);
    playT = setTimeout(() => { OrbitVoice.setPlaying(false); speakingFlag(false); }, (nextTime - playCtx.currentTime) * 1000 + 250);
  }
  // What they actually heard before cutting in: whole sentences already played, plus a share of the current one.
  let speakFlag = false;
  function speakingFlag(v) { if (v !== speakFlag) { speakFlag = v; try { api.voice.speaking(v); } catch {} } }
  function vlog(line) { try { api.voice.log && api.voice.log(line); } catch {} }
  function winSayNow(text) {
    try { if (typeof speechSynthesis === 'undefined') return; const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; const v = speechSynthesis.getVoices().find(x => /^en/i.test(x.lang)); if (v) u.voice = v; speechSynthesis.speak(u); } catch {}
  }
  window.OrbitWinSayNow = winSayNow;
  function heardText() {
    if (window.OrbitVoice && OrbitVoice.windows) return winSched.map(x => x.done ? x.text : x.text.slice(0, x.char || 0)).join(' ').trim();
    if (!playCtx) return '';
    const now = playCtx.currentTime; const out = [];
    for (const x of sched) {
      if (x.end <= now) out.push(x.text);
      else if (x.start < now) { const w = x.text.split(' '); out.push(w.slice(0, Math.max(1, Math.round(w.length * (now - x.start) / (x.end - x.start)))).join(' ')); }
    }
    return out.join(' ');
  }
  const orbitAudible = () => (window.OrbitVoice && OrbitVoice.winSpeaking) || (playCtx && nextTime > playCtx.currentTime + 0.05);
  function clip(name, gain) { if (OrbitVoice.windows) return; const c = OrbitVoice.clips[name]; if (c) playFloat(c, '', gain); }
  // Did the mic just pick up Orbit's own words? (speakers, no headphones)
  const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  function isEcho(text) {
    if (Date.now() - lastSpokenAt > 2500 && !orbitAudible()) return false;
    const mine = new Set(words((sched.concat(winSched)).slice(-4).map(x => x.text).join(' ')));
    const w = words(text); if (!w.length || !mine.size) return false;
    return w.filter(x => mine.has(x)).length / w.length >= 0.6;
  }
  // Cut Orbit off for real: they're actually talking.
  function cutIn() {
    if (!barge) return; barge = false;
    const heard = heardText();
    flush(); OrbitVoice.cancel(lastSeq); turnSeqs.clear();
    api.voice.interrupt({ heard });
  }
  // A turn that ends mid-thought ("and…", "so…") waits a beat for the rest.
  const trailing = (t) => /(\b(and|but|so|or|because|like|um+|uh+|the|a|to|of|with|then|also)|,)\s*\.{0,3}$/i.test(t.trim());
  function sendTurn(text, prosody) {
    $('#liveYou').textContent = text;
    waitingSince = Date.now();
    api.voice.turn({ text, prosody });
    // If the brain is slow, a soft "hmm" so the silence doesn't feel dead.
    clearTimeout(fillerT);
    fillerT = setTimeout(() => { if (waitingSince && !orbitAudible() && Math.random() < 0.6) clip('hmm', 0.8); }, 1500);
  }
  if (window.OrbitVoice) {
    OrbitVoice.onEars((m) => {
      if (!on || engine !== 'orbit') return;
      if (m.type === 'speech_start') {
        api.voice.talking(true);
        el().classList.add('you-talking');
        clearTimeout(fillerT);
        if (heldT) { clearTimeout(heldT); heldT = 0; } // they carried on after "and…": keep it for one turn
        if (orbitAudible() || turnSeqs.size) {
          // Maybe cutting in: go quiet at once, stop for good once it's clearly real talking.
          barge = true; duck();
        } else if (waitingSince) {
          // They kept going before Orbit answered: wait, and treat it as one turn.
          waitingSince = 0;
          api.voice.interrupt({ merge: true });
        }
        setStatus('listening');
      } else if (m.type === 'pause') {
        // A little "mm-hm" when they pause mid-story, like a person would. Not too often.
        const now = Date.now();
        if (m.spokeMs > 2600 && now - lastBc > 8000 && !orbitAudible() && Math.random() < 0.5) { lastBc = now; clip(['mhm', 'yeah', 'right'][Math.floor(Math.random() * 3)], 0.55); }
      } else if (m.type === 'speech_sustained') {
        if (barge && !isEcho('')) cutIn();
      } else if (m.type === 'speech_cancel') {
        api.voice.talking(false); el().classList.remove('you-talking');
        if (barge) { barge = false; unduck(); } // just a noise: carry on talking
        if (held && !heldT) { const t = held; held = ''; sendTurn(t, ''); }
      } else if (m.type === 'transcript') {
        api.voice.talking(false); el().classList.remove('you-talking');
        if (isEcho(m.text)) { if (barge) { barge = false; unduck(); } return; } // that was Orbit's own voice
        if (barge) cutIn();
        const text = (held ? held + ' ' : '') + m.text; held = '';
        if (trailing(text)) {
          held = text; $('#liveYou').textContent = text + ' …';
          heldT = setTimeout(() => { heldT = 0; const t = held; held = ''; if (t) sendTurn(t, m.prosody); }, 1300);
          return;
        }
        sendTurn(text, m.prosody);
      }
    });
    OrbitVoice.onVoice((m) => {
      if (!on || engine !== 'orbit') return;
      if (m.type === 'audio' && turnSeqs.has(m.seq)) {
        waitingSince = 0; clearTimeout(fillerT); lastSpokenAt = Date.now();
        playFloat(m.pcm, m.text);
        if (!m.text && sched.length) sched[sched.length - 1].end = nextTime; // a streamed piece of the same sentence
      }
      if (m.type === 'win_start' && turnSeqs.has(m.seq)) { waitingSince = 0; clearTimeout(fillerT); lastSpokenAt = Date.now(); winSched.push({ text: m.text, char: 0 }); if (winSched.length > 8) winSched.shift(); OrbitVoice.setPlaying(true); }
      if (m.type === 'win_boundary') { const x = winSched[winSched.length - 1]; if (x && x.text === m.text) x.char = m.char; }
      if (m.type === 'win_end') { const x = winSched.find(y => y.text === m.text && !y.done); if (x) x.done = true; lastSpokenAt = Date.now(); if (!OrbitVoice.winSpeaking) OrbitVoice.setPlaying(false); }
      if (m.type === 'spoken') turnSeqs.delete(m.seq);
    });
  }

  // The orb breathes with whoever is talking.
  const lvlBuf = new Uint8Array(256);
  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (!on) return;
      let out = 0;
      if (analyser) {
        analyser.getByteTimeDomainData(lvlBuf);
        let sum = 0; for (const v of lvlBuf) { const x = (v - 128) / 128; sum += x * x; }
        out = Math.sqrt(sum / lvlBuf.length);
      }
      const o = Math.min(1, out * 4), m = muted ? 0 : Math.min(1, micLevel * 6);
      el().style.setProperty('--out', o.toFixed(3));
      el().style.setProperty('--in', m.toFixed(3));
      el().classList.toggle('you-talking', m > 0.18 && o < 0.1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function setStatus(s, detail) {
    state = s;
    el().dataset.state = s;
    $('#liveStatus').textContent = s === 'working' && detail && detail !== 'On it' ? `Working: ${detail}` : (STATE_TEXT[s] || '');
  }

  async function stop() {
    if (!on) return;
    on = false;
    cancelAnimationFrame(raf);
    await api.live.stop();
    cleanup();
    el().classList.remove('open');
    window.dispatchEvent(new CustomEvent('orbit-live-ended'));
  }

  function cleanup() {
    flush();
    if (engine === 'orbit' && window.OrbitVoice) { OrbitVoice.cancel(); OrbitVoice.reset(); turnSeqs.clear(); waitingSince = 0; clearTimeout(fillerT); clearTimeout(heldT); heldT = 0; held = ''; barge = false; }
    try { if (outEl) { outEl.pause(); outEl.srcObject = null; } } catch {} outEl = null;
    try { micNode && micNode.disconnect(); } catch {}
    try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
    try { micCtx && micCtx.close(); } catch {}
    try { playCtx && playCtx.close(); } catch {}
    micNode = micStream = micCtx = playCtx = playGain = analyser = null;
  }

  function fail(message) {
    $('#liveOrbit').textContent = message;
    vlog('call failed: ' + message);
    winSayNow(`Voice mode hit a problem. ${String(message).replace(/https?:\S+/g, '').slice(0, 160)}`);
    setStatus('ended');
    on = false; cancelAnimationFrame(raf);
    api.live.stop(); cleanup();
    setTimeout(() => { if (!on) { el().classList.remove('open'); window.dispatchEvent(new CustomEvent('orbit-live-ended')); } }, 4500);
  }

  // A voice task finished after you hung up: a notification, and Orbit says it out loud.
  async function afterCall(e) {
    try { new Notification(`Done: ${e.title}`, { body: e.text.slice(0, 180), silent: true }); } catch {}
    try { if (window.OrbitVoice) await OrbitVoice.say(`That task's done. ${e.text}`); } catch {}
    window.dispatchEvent(new CustomEvent('orbit-updates-changed'));
  }

  function toggleMute() {
    muted = !muted;
    $('#liveMute').classList.toggle('on', muted);
    api.live.mute(muted);
  }

  api.on('live:event', (e) => {
    if (e.type === 'after_call') { afterCall(e); return; }
    if (!on) return;
    switch (e.type) {
      case 'audio': play(e.data); break;
      case 'say': { const n = OrbitVoice.speak(e.text, { id: e.id }); lastSeq = n; turnSeqs.add(n); break; }
      case 'say_done': break;
      case 'flush': flush(); break;
      case 'state':
        if (e.state === 'ended') { if (on) stop(); break; }
        setStatus(e.state, e.detail);
        break;
      case 'caption': {
        const node = e.who === 'you' ? $('#liveYou') : $('#liveOrbit');
        const t = e.text.trim();
        node.textContent = t.length > 220 ? '…' + t.slice(-220) : t;
        break;
      }
      case 'quick': {
        // Instant action: flash it under the orb.
        const st = $('#liveStatus'); const prev = st.textContent;
        st.textContent = (e.ok ? '\u26A1 ' : '') + String(e.result || '').replace(/^Error:\s*/, '');
        st.classList.add('flash'); clearTimeout(st._qt);
        st._qt = setTimeout(() => { st.classList.remove('flash'); if (st.textContent.startsWith('\u26A1') || !e.ok) st.textContent = prev; }, 1800);
        break;
      }
      case 'error':
        vlog('error: ' + e.message);
        if (e.fatal) fail(e.message);
        else { const st = $('#liveStatus'); st.textContent = 'Problem: ' + String(e.message).slice(0, 140); setTimeout(() => { if (on) setStatus(state); }, 8000); }
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!on) return;
    if (e.key === 'Escape') stop();
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); toggleMute(); }
  });

  window.addEventListener('DOMContentLoaded', () => {});
  window.OrbitLive = { start, stop, toggleMute, get on() { return on; } };
  document.addEventListener('click', (e) => {
    if (e.target.closest('#liveEnd')) stop();
    if (e.target.closest('#liveMute')) toggleMute();
  });
})();
