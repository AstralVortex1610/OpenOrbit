(async () => {
  const r = { ok: false };
  try {
    const t0 = performance.now();
    await OrbitVoice.ensure();
    r.loadMs = Math.round(performance.now() - t0); r.device = OrbitVoice.device; r.info = OrbitVoice.info; r.info = OrbitVoice.info; r.clips = Object.keys(OrbitVoice.clips); r.rtf = OrbitVoice.rtf; r.engine = OrbitVoice.engine; r.firstMs = OrbitVoice.firstMs;
    const sentence = 'Hey Orbit, can you open Spotify and play some lo-fi music for me?';
    const chunks = []; let first = 0;
    const t1 = performance.now();
    await new Promise((res) => {
      const off = OrbitVoice.onVoice((m) => { if (m.type === 'audio') { if (!first) first = performance.now() - t1; chunks.push(m.pcm); } if (m.type === 'spoken') { off(); res(); } });
      OrbitVoice.speak(sentence);
    });
    r.ttsFirstAudioMs = Math.round(first); r.ttsTotalMs = Math.round(performance.now() - t1);
    const t2 = performance.now(); let first2 = 0;
    await new Promise((res) => { const off = OrbitVoice.onVoice((m) => { if (m.type === 'audio' && !first2) first2 = performance.now() - t2; if (m.type === 'spoken') { off(); res(); } }); OrbitVoice.speak('Okay, opening it now.'); });
    r.warmShortSentenceMs = Math.round(first2);
    const n = chunks.reduce((a, c) => a + c.length, 0); const a24 = new Float32Array(n); let o = 0; for (const c of chunks) { a24.set(c, o); o += c.length; }
    r.audioSec = +(n / 24000).toFixed(2);
    // 24k -> 16k, with silence around it
    const a16 = new Float32Array(Math.floor(n * 2 / 3)); for (let i = 0; i < a16.length; i++) a16[i] = a24[Math.floor(i * 1.5)];
    const all = new Float32Array(16000 * 0.6 + a16.length + 16000 * 1.2); all.set(a16, 16000 * 0.6);
    const events = [];
    const got = new Promise((res) => OrbitVoice.onEars((m) => { if (m.type !== 'progress') events.push(m.type); if (m.type === 'transcript') res(m); }));
    for (let i = 0; i + 640 <= all.length; i += 640) { const s = new Int16Array(640); for (let j = 0; j < 640; j++) s[j] = Math.max(-1, Math.min(1, all[i + j])) * 32767; OrbitVoice.feed(s.buffer); await new Promise(z => setTimeout(z, 4)); }
    const t = await Promise.race([got, new Promise(z => setTimeout(() => z(null), 60000))]);
    r.earEvents = events; r.transcript = t && t.text; r.sttMs = t && t.sttMs; r.prosody = t && t.prosody;
    r.ok = !!(t && /spotify/i.test(t.text) && events.includes('speech_start'));
  } catch (e) { r.error = String(e && e.stack || e); }
  window.done(r);
})();
