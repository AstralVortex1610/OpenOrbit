// Fake ears/voice + fake Orbit API, so the call screen's turn-taking can be tested without a mic.
(function () {
  const ears = new Set(), voice = new Set(); let seq = 0;
  window.T = { calls: [], ears: (m) => ears.forEach(f => f(m)), cancels: 0 };
  window.OrbitVoice = {
    ensure: async () => true, ready: true, loading: false, device: 'wasm', windows: false, winSpeaking: false, clips: {}, rtf: 0.3,
    onEars(f) { ears.add(f); return () => ears.delete(f); }, onVoice(f) { voice.add(f); return () => voice.delete(f); }, onStatus() { return () => {}; },
    speak(text) { const n = ++seq; setTimeout(() => { const pcm = new Float32Array(24000 * 2); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 8) * 0.2; voice.forEach(f => f({ type: 'audio', seq: n, text, pcm })); voice.forEach(f => f({ type: 'spoken', seq: n })); }, 20); return n; },
    cancel() { T.cancels++; }, setPlaying() {}, reset() {}, setVoice() {}, setPauseMs() {}, setWinVoice() {}, feed() {}, say: async () => true,
  };
  let liveH = null;
  window.orbit = {
    live: { status: async () => ({ ready: true, engine: 'orbit', inRate: 16000, voice: 'af_heart' }), start: async () => ({ ok: true, engine: 'orbit' }), stop: async () => {}, mute: async () => {}, audio() {} },
    voice: { turn: (t) => T.calls.push(['turn', t.text]), interrupt: (x) => T.calls.push(['interrupt', x.heard || (x.merge ? 'MERGE' : '')]), talking: () => {}, opener: () => { T.opener = (T.opener || 0) + 1; }, speaking: () => {}, log: async () => true },
    getSettings: async () => ({}),
    on: (ch, fn) => { if (ch === 'live:event') liveH = fn; },
  };
  T.event = (e) => liveH(e);
})();
