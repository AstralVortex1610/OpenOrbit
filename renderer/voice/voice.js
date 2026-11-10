// Orbit Voice (renderer side): starts the two on-device workers and plays Orbit's voice.
//   OrbitVoice.ensure()        load ears + voice (downloads once, ~250 MB, then offline)
//   OrbitVoice.feed(pcm16)     mic audio at 16 kHz for the ears
//   OrbitVoice.speak(text)     queue speech; returns a seq number; audio arrives via onVoice
//   OrbitVoice.say(text)       read something aloud right now (chat replies, the Listen button)
(function () {
  const api = window.orbit;
  let ears = null, voice = null, loading = null, seq = 0, clips = {}, device = '', useWin = false, rtf = 0, winName = '', engine = '', firstMs = 0;
  const info = {};
  const earsL = new Set(), voiceL = new Set(), statusL = new Set();
  let lastStatus = null;
  const status = (s) => { lastStatus = s; statusL.forEach(f => f(s)); };

  const LIMIT = 6 * 60 * 1000; // after downloads, starting can't take longer than this
  function spawn(role, base, s, cpu) {
    return new Promise((resolve, reject) => {
      const w = new Worker('voice/worker.js', { type: 'module' });
      let timer = null; const arm = () => { clearTimeout(timer); timer = setTimeout(() => { w.terminate(); reject(Object.assign(new Error('Starting the voice took too long'), { timeout: true })); }, LIMIT); };
      arm();
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') arm();
        if (m.type === 'clip') clips[m.name] = m.pcm;
        if (m.type === 'ready') { clearTimeout(timer); device = m.device; if (role === 'voice') { if (m.rtf) rtf = m.rtf; engine = m.engine || 'kokoro'; firstMs = m.firstMs || 0; } if (m.clips) clips = m.clips; if (m.threads) info[role] = { threads: m.threads, isolated: m.isolated, sab: m.sab }; resolve(w); }
        else if (m.type === 'error' && m.fatal) { clearTimeout(timer); w.terminate(); reject(new Error(m.message)); }
        else if (m.type === 'status') status({ text: m.text });
        if (role === 'ears') earsL.forEach(f => f(m)); else voiceL.forEach(f => f(m));
      };
      w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message || 'Voice worker failed to start')); };
      w.postMessage({ type: 'init', role, base, sttModel: s.orbitStt || 'moonshine', voice: s.orbitVoice || 'af_heart', cpu: !!cpu, tts: (s.orbitTts || 'auto') === 'kokoro' ? 'kokoro' : 'phonon', phononVoice: s.orbitPhononVoice || 'Easton' });
    });
  }

  // Orbit speaks with Phonon 31m (default: streams, starts almost at once, about 160 MB once), Kokoro
  // (the older natural voice) or Windows' own Microsoft voices (instant, nothing to download).
  // 'auto' = Phonon, falling back to the Windows voice if Phonon can't start or is too slow here.
  // 'phonon' = Phonon, falling back to the Windows voice only if it can't start. So a call always runs.
  const ttsMode = (s) => s.orbitTts || 'auto';
  const winOk = () => typeof speechSynthesis !== 'undefined';
  const voiceReady = () => useWin || !!voice;
  async function ensure() {
    if (ears && voiceReady()) return true;
    if (loading) return loading;
    loading = (async () => {
      const base = await api.voice.base();
      const s = await api.getSettings();
      const mode = ttsMode(s);
      winName = s.orbitWinVoice || '';
      status({ text: 'Waking up Orbit\'s voice…' });
      // CPU by default: on laptops without a real graphics card the GPU path is slower and can hang.
      const cpu = !s.orbitGpu || localStorage.getItem('orbitVoiceCpu') === '1';
      const run = async (c) => {
        const ep = spawn('ears', base, s, c);
        if (mode === 'windows' && winOk()) { useWin = true; return [await ep, null]; }
        const vp = spawn('voice', base, s, c);
        const [e, v] = await Promise.allSettled([ep, vp]);
        if (e.status === 'rejected') { if (v.status === 'fulfilled') v.value.terminate(); throw e.reason; }
        if (v.status === 'rejected') {
          if ((mode === 'auto' || mode === 'phonon') && winOk()) { useWin = true; return [e.value, null]; } // the voice wouldn't start: talk with Windows' voice
          e.value.terminate(); throw v.reason;
        }
        return [e.value, v.value];
      };
      try { [ears, voice] = await run(cpu); }
      catch (e) {
        if (cpu) throw e;
        // Second try on the CPU only, and remember that for next time.
        status({ text: 'Trying again on the CPU…' });
        [ears, voice] = await run(true);
        localStorage.setItem('orbitVoiceCpu', '1');
      }
      if (voice && mode === 'auto' && rtf > 0.8 && winOk()) {
        // Too slow to talk without awkward gaps on this laptop: free the CPU for listening, use Windows' voice.
        voice.terminate(); voice = null; useWin = true;
      }
      if (useWin) await winVoices();
      status({ text: '', ready: true, device: useWin ? 'windows' : device }); lastStatus = null;
      return true;
    })().catch((e) => { loading = null; lastStatus = null; ears = voice = null; useWin = false; throw e; });
    return loading;
  }

  // ---------- Windows (Microsoft) voices ----------
  function winVoices() {
    return new Promise((res) => {
      const v = speechSynthesis.getVoices(); if (v.length) return res(v);
      const t = setTimeout(() => res(speechSynthesis.getVoices()), 1500);
      speechSynthesis.onvoiceschanged = () => { clearTimeout(t); res(speechSynthesis.getVoices()); };
    });
  }
  function pickWin() {
    const all = speechSynthesis.getVoices();
    if (winName) { const v = all.find(x => x.name === winName); if (v) return v; }
    const en = all.filter(x => /^en/i.test(x.lang));
    return en.find(x => /natural/i.test(x.name) && /en-IN/i.test(x.lang)) || en.find(x => /natural/i.test(x.name))
      || en.find(x => /en-IN/i.test(x.lang)) || en.find(x => /Zira|Aria|Jenny/i.test(x.name)) || en[0] || all[0] || null;
  }
  let winQ = 0, winCut = 0; const winOn = new Set();
  function winSpeak(text, n, id) {
    const parts = String(text).split(/(?<=[.!?…]["')\]]*)\s+/).map(t => t.trim()).filter(Boolean);
    const voiceObj = pickWin();
    parts.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t);
      if (voiceObj) { u.voice = voiceObj; u.lang = voiceObj.lang; }
      u.rate = 1.05;
      winQ++;
      u.onstart = () => { if (n <= winCut) return; winOn.add(u); voiceL.forEach(f => f({ type: 'win_start', id, seq: n, text: t, at: performance.now() })); };
      u.onboundary = (e) => { voiceL.forEach(f => f({ type: 'win_boundary', seq: n, text: t, char: e.charIndex })); };
      const done = () => { winQ = Math.max(0, winQ - 1); winOn.delete(u); voiceL.forEach(f => f({ type: 'win_end', seq: n, text: t })); if (i === parts.length - 1 && n > winCut) voiceL.forEach(f => f({ type: 'spoken', id, seq: n })); };
      u.onend = done; u.onerror = done;
      speechSynthesis.speak(u);
    });
    if (!parts.length) voiceL.forEach(f => f({ type: 'spoken', id, seq: n }));
  }
  function winStop() { winCut = seq; winQ = 0; winOn.clear(); try { speechSynthesis.cancel(); } catch {} }

  // Download progress from the model cache, summed across files.
  const files = new Map();
  api.on('voice:progress', (p) => {
    files.set(p.file, p);
    let loaded = 0, total = 0; for (const f of files.values()) { loaded += f.done ? f.total : f.loaded; total += f.total; }
    const allDone = [...files.values()].every(f => f.done);
    status({ text: allDone ? 'Downloaded. Starting Orbit\'s voice (first start can take a minute)…' : `Downloading Orbit's voice, one time only: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`, progress: total ? loaded / total : 0 });
  });

  // ---------- chat read-aloud player ----------
  let ctx = null, next = 0, srcs = [], current = 0;
  function playFloat(f) {
    if (!ctx) ctx = new AudioContext({ sampleRate: 24000 });
    const b = ctx.createBuffer(1, f.length, 24000); b.copyToChannel(f, 0);
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination);
    const t = Math.max(ctx.currentTime + 0.03, next); src.start(t); next = t + b.duration;
    srcs.push(src); src.onended = () => { srcs = srcs.filter(x => x !== src); };
  }
  function stopSay() { if (current) cancel(current); current = 0; srcs.forEach(s => { try { s.stop(); } catch {} }); srcs = []; next = 0; if (useWin) winStop(); }
  voiceL.add((m) => { if (m.type === 'audio' && m.seq === current) playFloat(m.pcm); });

  function clean(text) {
    return String(text || '').replace(/```[\s\S]*?```/g, ' The code is on screen. ').replace(/\|.*\|/g, ' ').replace(/https?:\/\/\S+/g, 'a link')
      .replace(/[#*_`>~]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\n+/g, ' ').trim().slice(0, 1500);
  }

  function speak(text, opts = {}) {
    const n = ++seq;
    if (useWin) winSpeak(text, n, opts.id || n);
    else voice.postMessage({ type: 'speak', id: opts.id || n, seq: n, text, speed: opts.speed });
    return n;
  }
  function cancel(upTo) { if (useWin) { winStop(); return; } if (voice) voice.postMessage({ type: 'cancel', upTo: upTo || seq }); }

  async function say(text) {
    stopSay();
    try { await ensure(); } catch (e) { return false; }
    current = speak(clean(text));
    return true;
  }

  window.OrbitVoice = {
    ensure, say, stopSay, speak, cancel, clean,
    get ready() { return !!(ears && voiceReady()); },
    get device() { return useWin ? 'windows' : device; },
    get windows() { return useWin; },
    get winSpeaking() { return useWin && (winQ > 0 || speechSynthesis.speaking); },
    get rtf() { return rtf; },
    get engine() { return useWin ? 'windows' : engine; },
    get firstMs() { return firstMs; },
    setPhononVoice(n) { if (voice && engine === 'phonon') voice.postMessage({ type: 'phononVoice', voice: n }); },
    winPause() { try { speechSynthesis.pause(); } catch {} },
    winResume() { try { speechSynthesis.resume(); } catch {} },
    winVoiceList() { return winOk() ? winVoices().then(v => v.filter(x => /^en|^hi/i.test(x.lang)).map(x => ({ name: x.name, lang: x.lang }))) : Promise.resolve([]); },
    setWinVoice(n) { winName = n || ''; },
    unload() { stopSay(); try { ears && ears.terminate(); } catch {} try { voice && voice.terminate(); } catch {} ears = voice = null; loading = null; useWin = false; },
    setPauseMs(ms) { if (ears) ears.postMessage({ type: 'endMs', ms }); },
    get info() { return info; },
    get clips() { return clips; },
    get speaking() { return srcs.length > 0 || (useWin && speechSynthesis.speaking); },
    feed(pcm) { if (ears) ears.postMessage({ type: 'audio', pcm }, [pcm]); },
    setPlaying(on) { if (ears) ears.postMessage({ type: 'playing', on }); },
    setVoice(v) { if (voice) voice.postMessage({ type: 'voice', voice: v }); },
    reset() { if (ears) ears.postMessage({ type: 'reset' }); },
    onEars(f) { earsL.add(f); return () => earsL.delete(f); },
    onVoice(f) { voiceL.add(f); return () => voiceL.delete(f); },
    onStatus(f) { statusL.add(f); if (loading && lastStatus && lastStatus.text) f(lastStatus); return () => statusL.delete(f); },
    get loading() { return !!loading && !(ears && voiceReady()); },
  };
})();
