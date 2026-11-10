// Orbit — offline "Hey Orbit" wake word. Runs a tiny Vosk speech model entirely on the laptop;
// no audio leaves the machine until the wake phrase is heard and the user's request is recorded.
(function () {
  const PHRASES = ['hey orbit', 'okay orbit', 'hi orbit'];
  // Filler words give everyday speech somewhere to land, so it isn't forced onto "orbit".
  const GRAMMAR = JSON.stringify([...PHRASES, 'orbit', 'hey', 'okay', 'hi', 'or', 'bit', 'robert', 'about', 'it', 'the', 'a', 'open', 'what', 'there', '[unk]']);
  const MIN_CONF = 0.92; // tuned on synthetic voices: real wakes scored 1.00, near-misses 0.83 to 0.88
  let model = null, recognizer = null, ctx = null, stream = null, node = null, source = null;
  let paused = false, running = false, lastFire = 0;

  async function loadModel() {
    if (model) return model;
    const bytes = await window.orbit.getWakeModel();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }));
    model = await Vosk.createModel(url);
    return model;
  }

  function heard(text) {
    const t = String(text || '').toLowerCase().trim();
    return PHRASES.some(p => t.includes(p));
  }

  // Two-stage: a partial hit starts recording at once (so "Hey Orbit, open Chrome" in one breath
  // isn't lost), then the final result confirms or cancels it based on word confidence.
  let tentative = false, confirmTimer = null;
  function fire(text) {
    const now = Date.now();
    if (paused || tentative || now - lastFire < 2500) return;
    lastFire = now; tentative = true;
    window.dispatchEvent(new CustomEvent('orbit-wake', { detail: { text } }));
    confirmTimer = setTimeout(() => settle(true), 4000);
  }
  function settle(ok) {
    if (!tentative) return;
    tentative = false; clearTimeout(confirmTimer);
    window.dispatchEvent(new CustomEvent(ok ? 'orbit-wake-confirm' : 'orbit-wake-cancel'));
  }
  function judge(result) {
    const words = (result && result.result) || [];
    return words.some(w => w.word === 'orbit' && (w.conf || 0) >= MIN_CONF);
  }

  async function start() {
    if (running) return;
    running = true;
    try {
      await loadModel();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      ctx = new AudioContext();
      recognizer = new model.KaldiRecognizer(ctx.sampleRate, GRAMMAR);
      recognizer.setWords(true);
      recognizer.on('partialresult', (m) => { const p = m.result && m.result.partial; if (p && /\borbit\b/.test(p)) fire(p); });
      recognizer.on('result', (m) => {
        const ok = judge(m.result);
        if (tentative) settle(ok);
        else if (ok && !paused) { fire(m.result.text); settle(true); }
      });
      source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => { if (!paused && recognizer) { try { recognizer.acceptWaveform(e.inputBuffer); } catch {} } };
      source.connect(node); node.connect(ctx.destination);
      window.dispatchEvent(new CustomEvent('orbit-wake-state', { detail: { on: true } }));
    } catch (err) {
      running = false;
      stop();
      window.dispatchEvent(new CustomEvent('orbit-wake-state', { detail: { on: false, error: String(err && err.message || err) } }));
    }
  }

  function stop() {
    running = false;
    try { node && node.disconnect(); source && source.disconnect(); } catch {}
    try { recognizer && recognizer.remove(); } catch {}
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch {}
    try { ctx && ctx.close(); } catch {}
    node = source = recognizer = stream = ctx = null;
    window.dispatchEvent(new CustomEvent('orbit-wake-state', { detail: { on: false } }));
  }

  // For tests: run a 16 kHz mono Float32Array through a fresh recognizer and return what it heard.
  async function recognizeSamples(samples, sampleRate, grammar) {
    await loadModel();
    const r0 = 0; const r = grammar === 'none' ? new model.KaldiRecognizer(sampleRate) : new model.KaldiRecognizer(sampleRate, grammar || GRAMMAR);
    r.setWords(true); let words = [];
    return await new Promise((resolve) => {
      let out = '';
      r.on('result', (m) => { if (m.result && m.result.text) { out += ' ' + m.result.text; words = words.concat(m.result.result || []); } });
      const step = 4096;
      for (let i = 0; i < samples.length; i += step) r.acceptWaveformFloat(samples.subarray(i, i + step), sampleRate);
      r.acceptWaveformFloat(new Float32Array(sampleRate), sampleRate);
      setTimeout(() => { r.retrieveFinalResult(); setTimeout(() => { r.remove(); resolve({ text: out.trim(), wake: judge({ result: words }), words: words.map(w => w.word + ':' + (w.conf || 0).toFixed(2)).join(' ') }); }, 800); }, 1500);
    });
  }

  window.OrbitWake = { start, stop, pause: () => { paused = true; }, resume: () => { paused = false; tentative = false; }, get on() { return running; }, recognizeSamples, heard };
})();
