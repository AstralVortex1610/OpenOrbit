// Orbit Voice — the on-device ears and voice, in a Web Worker.
//   ears  : Silero VAD (turn-taking, barge-in, pauses) + Moonshine or Whisper (speech to text)
//   voice : Phonon 31m by Gradium (default: streaming, starts talking almost at once, 24 kHz)
//           or Kokoro-82M (the older natural voice, kept as a fallback)
//   feel  : simple prosody (loudness, pitch, pace) compared to your own baseline, so Orbit can tell
//           when you sound tired, excited or rushed.
// Models download once through Orbit's local model cache (main process), then run fully offline.
import { AutoModel, AutoConfig, AutoTokenizer, PreTrainedModel, Tensor, pipeline, env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-node';

let BASE = '';
const post = (m, t) => self.postMessage(m, t || []);

// Everything Hugging Face or the ONNX runtime asks for goes through the local cache server.
const realFetch = self.fetch.bind(self);
self.fetch = (url, opts) => {
  const u = typeof url === 'string' ? url : url.url;
  if (BASE && /^https:\/\/huggingface\.co\//.test(u)) return realFetch(BASE + '/hf/' + u.slice('https://huggingface.co/'.length), opts);
  if (BASE && /^https:\/\/cdn\.jsdelivr\.net\//.test(u)) return realFetch(BASE + '/cdn/' + u.slice('https://cdn.jsdelivr.net/'.length), opts);
  return realFetch(url, opts);
};

const SR = 16000, FRAME = 512;
let vad = null, vadState = null, sr = null, stt = null, tts = null, voice = 'af_heart', device = 'wasm';
let ready = false, engine = 'kokoro';
const clips = {};

// Some laptops' graphics drivers hang (instead of failing) when a model starts on the GPU,
// so every GPU step has a time limit and falls back to the CPU.
const GPU_LIMIT = 60000;
function within(ms, p, what) {
  let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out')), ms); })]).finally(() => clearTimeout(t));
}
async function pickDevice(cpuOnly) {
  if (cpuOnly) return 'wasm';
  try { if (self.navigator.gpu && await within(4000, self.navigator.gpu.requestAdapter(), 'GPU check')) return 'webgpu'; } catch {}
  return 'wasm';
}
// Load on the GPU with a time limit; on failure or a hang, load on the CPU instead.
async function load(make, what) {
  if (device === 'webgpu') {
    try { return await within(GPU_LIMIT, make('webgpu'), what); }
    catch (e) { device = 'wasm'; post({ type: 'status', text: `${what}: your GPU didn't cooperate, switching to the CPU…`, device }); }
  }
  return make('wasm');
}

// One bundle, two workers: 'ears' (VAD + STT) and 'voice' (TTS), so speaking never delays hearing you.
async function init({ base, sttModel, voice: v, role, cpu, tts: ttsEngine, phononVoice }) {
  BASE = base;
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.remoteHost = base + '/hf/';
  // The ONNX runtime's wasm comes through the cache too (downloaded once, not shipped in the installer).
  // Only the .wasm binary is fetched; the JS glue is already in this bundle (so its threads are same-origin).
  env.backends.onnx.wasm.wasmPaths = { wasm: `${base}/cdn/npm/onnxruntime-web@${__ORT_VERSION__}/dist/ort-wasm-simd-threaded.asyncify.wasm` };
  if (typeof SharedArrayBuffer !== 'undefined') env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, Math.floor((self.navigator.hardwareConcurrency || 2) / 2)));
  voice = v || voice;
  device = await pickDevice(cpu);
  const progress = (what) => (p) => { if (p.status === 'progress') post({ type: 'progress', what, file: p.file, loaded: p.loaded, total: p.total }); };
  if (role === 'voice' && ttsEngine === 'phonon') { engine = 'phonon'; return initPhonon(progress, phononVoice); }
  if (role === 'voice') return initVoice(progress);
  post({ type: 'status', text: 'Loading ears…', device });
  vad = await AutoModel.from_pretrained('onnx-community/silero-vad', { config: { model_type: 'custom' }, dtype: 'fp32', progress_callback: progress('vad') });
  vadState = new Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  sr = new Tensor('int64', [SR], []);
  const sttId = sttModel === 'whisper' ? 'onnx-community/whisper-base' : 'onnx-community/moonshine-base-ONNX';
  post({ type: 'status', text: `Starting ears on your ${device === 'webgpu' ? 'GPU' : 'CPU'}…`, device });
  stt = await load((d) => pipeline('automatic-speech-recognition', sttId, { device: d, dtype: d === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8', progress_callback: progress('stt') }), 'Ears');
  ready = true;
  post({ type: 'ready', device, threads: env.backends.onnx.wasm.numThreads, isolated: !!self.crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined' });
}

async function initVoice(progress) {
  post({ type: 'status', text: 'Loading voice…', device });
  tts = await load((d) => KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: d === 'webgpu' ? 'fp32' : 'q8', device: d, progress_callback: progress('tts') }), 'Voice');
  post({ type: 'status', text: 'Warming up the voice…', device });
  // One tiny test word, also with a time limit on the GPU (that's where a hang shows up).
  if (device === 'webgpu') {
    try { await within(GPU_LIMIT, synth('Hi.'), 'Voice warm-up'); }
    catch { device = 'wasm'; post({ type: 'status', text: 'Your GPU didn\'t cooperate, switching the voice to the CPU…', device }); tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'wasm', progress_callback: progress('tts') }); }
  }
  // How fast this laptop speaks: seconds of work per second of speech. Above ~0.8 the voice lags,
  // and the app switches to the instant Windows voice when it's set to Auto.
  let rtf = 0;
  try { const t0 = performance.now(); const a = await synth('Okay, this is a quick check of how fast I can talk.'); rtf = (performance.now() - t0) / 1000 / (a.length / 24000); } catch {}
  ready = true;
  post({ type: 'ready', device, threads: env.backends.onnx.wasm.numThreads, rtf: Math.round(rtf * 100) / 100 });
  // Little human sounds, made in the background so they never hold up "ready".
  for (const [k, t] of Object.entries({ mhm: 'Mm-hmm.', yeah: 'Yeah.', right: 'Right.', okay: 'Okay.', hmm: 'Hmm.', so: 'Okay, so.' })) {
    await idle();
    try { const a = await synth(t, 1.05); post({ type: 'clip', name: k, pcm: a.slice() }); } catch {}
  }
}

async function synth(text, speed = 1) {
  if (engine === 'phonon') { const parts = []; for await (const f of phSpeak(text)) parts.push(f); return join(parts); }
  const a = await tts.generate(text, { voice, speed });
  return a.audio; // Float32Array, 24 kHz
}
const join = (parts) => { const out = new Float32Array(parts.reduce((n, c) => n + c.length, 0)); let o = 0; for (const c of parts) { out.set(c, o); o += c.length; } return out; };

// ---------------- Phonon 31m (Gradium, Apache 2.0) ----------------
// Two ONNX graphs: flow_lm makes one latent per 80 ms frame, mimi_decoder turns each latent into
// 1920 samples of 24 kHz audio, so Orbit can start playing after the first frame.
// Runs on transformers.js directly (its text-to-speech pipeline for Phonon isn't released yet).
const PHONON = 'onnx-community/phonon-31m-en-ONNX';
export const PHONON_VOICES = {
  Easton: 'LMDIYE0Oa377Qh6Z', Zoey: 'NbpkqMVS3CJeq2j8', Juniper: 'NIWIOv5vTi5eRMj8', Everly: 'vjFyp2BcCyTlUmYb', Harper: '4SZHfMpw-p46Ywgs',
  Hadley: 'bXwrkHhURL1VFJdG', Delia: 'nGzMHMPAWGaJFHOo', Micah: '40QrMVgAxFiUnP9f', Trevor: '0zLApsZfVLLNaEGl', Russell: '_6Aslh2DxfmnRLmP',
  Preston: 'qIxlZ7Ei8KvWlyQH', Miles: 'd9XCyhjo4JhkHF1d', Maeve: '6PWnV0Nq4wu7RVBT', Freya: 'GgfEkEJtxZR7gnpy', Pippa: 'uem82D50GRv2Dwma',
  Imogen: 'gDT1nz7Ie36ZhL-C', Lottie: 'm9MxpY6IUGXtWp76', Bryony: 'gfP44RlHwr2kEwk7', Alfie: 'X6NceqF285Gr04gb', Hugh: 'YyKcxPG7iIgS3jsK',
  Edwin: 'zUCxzrOrugTSis03', Spencer: 'JOW0vchyswkQUMDS', Toby: 'dME3IWyZBvmh1n1q', Teddy: 'Zn7g6NxLqXlJb7Qi', Default: 'default',
};
let ph = null; // { cfg, tok, flow, mimi, voiceState, voiceName }
const f32 = (dims, data) => new Tensor('float32', data ?? new Float32Array(dims.reduce((a, b) => a * b, 1)), dims);
const i64 = (values, dims) => new Tensor('int64', BigInt64Array.from(values, BigInt), dims);
const emptyCache = ({ num_layers, num_heads, head_dim }) => Object.fromEntries(
  Array.from({ length: num_layers }, (_, i) => ['key', 'value'].map((k) => [`past_key_values.${i}.${k}`, f32([1, num_heads, 0, head_dim])])).flat());
const nextState = (outputs) => Object.fromEntries(Object.entries(outputs)
  .filter(([name]) => name.startsWith('present'))
  .map(([name, value]) => [name.replace('present.', 'past_key_values.').replace('present_', 'past_'), value]));
const release = (...states) => states.forEach((st) => Object.values(st).forEach((t) => t && t.location === 'gpu-buffer' && t.dispose()));
const runFlow = (past, { text = [], voiceLatents, latent, noise }) => ph.flow({
  text_ids: i64(text, [1, text.length]), voice_latents: voiceLatents || f32([1, ph.cfg.voice_dim, 0]),
  latent: latent || f32([1, 0, ph.cfg.latent_dim]), noise: noise || f32([1, ph.cfg.latent_dim]),
  num_speakers: i64([1], [1]), duration_delta: f32([1]), ...past,
});

async function phLoad(d, progress) {
  const config = await AutoConfig.from_pretrained(PHONON);
  const cfg = config.phonon;
  const dtype = d === 'webgpu' ? 'q4f16' : 'fp32'; // fp32 is the fastest on the CPU (4-bit math is slower in wasm)
  const caches = ({ num_layers }) => Array.from({ length: num_layers }, (_, i) => [`present.${i}.key`, `present.${i}.value`]).flat();
  const convStates = Object.keys(cfg.mimi_decoder.conv_states).map((n) => n.replace('past_', 'present_'));
  const onGpu = (names) => (d === 'webgpu' ? { session_options: { preferredOutputLocation: Object.fromEntries(names.map((n) => [n, 'gpu-buffer'])) } } : {});
  const tok = await AutoTokenizer.from_pretrained(PHONON, { progress_callback: progress('tts') });
  const flow = await PreTrainedModel.from_pretrained(PHONON, { config, model_file_name: 'flow_lm', dtype, device: d, progress_callback: progress('tts'), ...onGpu(['latent_out', ...caches(cfg.flow_lm)]) });
  const mimi = await PreTrainedModel.from_pretrained(PHONON, { config, model_file_name: 'mimi_decoder', dtype, device: d, progress_callback: progress('tts'), ...onGpu([...caches(cfg.mimi_decoder), ...convStates]) });
  // Unigram with byte fallback, which transformers.js doesn't apply yet.
  const uni = tok._tokenizer && tok._tokenizer.model;
  if (uni && !uni.byte_fallback && uni.encode && uni.tokens_to_ids) {
    const enc = uni.encode.bind(uni);
    uni.encode = (tokens) => enc(tokens).flatMap((piece) => {
      if (uni.tokens_to_ids.has(piece)) return [piece];
      const bytes = Array.from(new TextEncoder().encode(piece), (b) => `<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`);
      return bytes.every((b) => uni.tokens_to_ids.has(b)) ? bytes : [piece];
    });
  }
  return { cfg, tok, flow, mimi, voiceState: null, voiceName: '' };
}
async function phSetVoice(name) {
  const n = PHONON_VOICES[name] ? name : 'Easton';
  if (ph.voiceName === n && ph.voiceState) return;
  const data = new Float32Array(await (await self.fetch(`https://huggingface.co/${PHONON}/resolve/main/voices/${PHONON_VOICES[n]}.bin`)).arrayBuffer());
  const v = f32([1, ph.cfg.voice_dim, data.length / ph.cfg.voice_dim], data);
  const st = nextState(await runFlow(emptyCache(ph.cfg.flow_lm), { voiceLatents: v }));
  if (ph.voiceState) release(ph.voiceState);
  ph.voiceState = st; ph.voiceName = n;
}
// One Float32Array of 24 kHz audio per 80 ms frame. Keep each call to about one sentence.
async function* phSpeak(sentence, stop) {
  const cfg = ph.cfg;
  let text = String(sentence).trim().replace(/\s+/g, ' ');
  if (!text) return;
  text = text[0].toUpperCase() + text.slice(1) + (/[\p{L}\p{N}]$/u.test(text) ? '.' : '');
  const ids = ph.tok.encode(text, { add_special_tokens: false });
  let state = nextState(await runFlow(ph.voiceState, { text: ids }));
  let codec = { past_offset: i64([0], [1]), ...emptyCache(cfg.mimi_decoder) };
  for (const [name, dims] of Object.entries(cfg.mimi_decoder.conv_states)) codec[name] = f32(dims);
  let latent = f32([1, 1, cfg.latent_dim], new Float32Array(cfg.latent_dim).fill(NaN));
  const temp = cfg.temperature ?? 0.3;
  const randn = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  let countdown = null;
  try {
    for (let frame = 0; frame < Math.ceil((ids.length / 3 + 2) * cfg.frame_rate); frame++) {
      if (stop && stop()) return;
      const noise = f32([1, cfg.latent_dim], Float32Array.from({ length: cfg.latent_dim }, () => randn() * Math.sqrt(temp)));
      const step = await runFlow(state, { latent, noise });
      release(state, { latent });
      [state, latent] = [nextState(step), step.latent_out];
      const decoded = await ph.mimi({ latent, ...codec });
      release(codec);
      codec = nextState(decoded);
      yield new Float32Array(decoded.audio.data);
      if (countdown === null && step.eos_logit.data[0] > cfg.eos_threshold) countdown = text.split(' ').length <= 4 ? 3 : 1;
      if (countdown !== null && countdown-- === 0) break;
    }
  } finally { release(state, codec, { latent }); }
}

async function initPhonon(progress, name) {
  post({ type: 'status', text: 'Loading Phonon voice…', device });
  ph = await load((d) => phLoad(d, progress), 'Phonon voice');
  post({ type: 'status', text: 'Warming up the voice…', device });
  try { await within(device === 'webgpu' ? GPU_LIMIT : 180000, phSetVoice(name), 'Voice warm-up'); }
  catch (e) {
    if (device !== 'webgpu') throw e;
    device = 'wasm'; post({ type: 'status', text: 'Your GPU didn\'t cooperate, switching the voice to the CPU…', device });
    ph = await phLoad('wasm', progress); await phSetVoice(name);
  }
  // Speed check: first audio and seconds of work per second of speech.
  let rtf = 0, firstMs = 0;
  try {
    const t0 = performance.now(); const parts = [];
    for await (const f of phSpeak('Okay, this is a quick check of how fast I can talk.')) { if (!firstMs) firstMs = performance.now() - t0; parts.push(f); }
    rtf = (performance.now() - t0) / 1000 / (join(parts).length / 24000);
  } catch {}
  ready = true;
  lastSpoke = performance.now(); // let the first real words go before the background clips
  post({ type: 'ready', device, engine: 'phonon', threads: env.backends.onnx.wasm.numThreads, rtf: Math.round(rtf * 100) / 100, firstMs: Math.round(firstMs) });
  for (const [k, t] of Object.entries({ mhm: 'Mm-hmm.', yeah: 'Yeah.', right: 'Right.', okay: 'Okay.', hmm: 'Hmm.' })) {
    await idle();
    try { const a = await synth(t); post({ type: 'clip', name: k, pcm: a.slice() }); } catch {}
  }
}

// ---------------- listening ----------------
let buf = new Float32Array(0);
let inSpeech = false, speechMs = 0, silenceMs = 0, playing = false, startProb = 0.5, utter = [], preroll = [], pauseSent = 0, voicedMs = 0, sustained = 0;
const PRE_FRAMES = 10; // ~320 ms kept from before speech started
let endMs = 900; // silence that ends your turn; long enough for a thinking pause

async function feed(int16) {
  if (!ready) return;
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f[i] = int16[i] / 0x8000;
  const nb = new Float32Array(buf.length + f.length); nb.set(buf); nb.set(f, buf.length); buf = nb;
  while (buf.length >= FRAME) {
    const frame = buf.slice(0, FRAME); buf = buf.slice(FRAME);
    const { output, stateN } = await vad({ input: new Tensor('float32', frame, [1, FRAME]), sr, state: vadState });
    vadState = stateN;
    const p = output.data[0];
    const ms = FRAME / SR * 1000;
    const threshold = playing ? Math.max(startProb, 0.85) : startProb; // Orbit's own voice leaking into the mic shouldn't count
    if (!inSpeech) {
      preroll.push(frame); if (preroll.length > PRE_FRAMES) preroll.shift();
      if (p > threshold) { speechMs += ms; if (speechMs >= (playing ? 220 : 90)) { inSpeech = true; silenceMs = 0; pauseSent = 0; utter = preroll.slice(); preroll = []; voicedMs = speechMs; sustained = 0; post({ type: 'speech_start', barge: playing }); } }
      else speechMs = Math.max(0, speechMs - ms);
      continue;
    }
    utter.push(frame);
    // Real talking, not a cough or a door: enough clearly voiced audio. Only then does Orbit stop for good.
    if (p > 0.5) { voicedMs += ms; if (!sustained && voicedMs >= 450) { sustained = 1; post({ type: 'speech_sustained' }); } }
    if (p < 0.35) {
      silenceMs += ms;
      if (silenceMs >= 220 && !pauseSent) { pauseSent = 1; post({ type: 'pause', spokeMs: utter.length * ms }); }
      if (silenceMs >= endMs) await endTurn();
    } else { silenceMs = 0; pauseSent = 0; }
    if (utter.length * ms > 30000) await endTurn();
  }
}

async function endTurn() {
  inSpeech = false; speechMs = 0; silenceMs = 0;
  const frames = utter; utter = [];
  const audio = new Float32Array(frames.length * FRAME);
  frames.forEach((fr, i) => audio.set(fr, i * FRAME));
  const durSec = audio.length / SR;
  if (durSec < 0.35) { post({ type: 'speech_cancel' }); return; }
  post({ type: 'speech_end', sec: durSec });
  const t0 = performance.now();
  let text = '';
  try { const r = await stt(audio); text = (r.text || '').trim(); } catch (e) { post({ type: 'error', message: 'Speech recognition failed: ' + e.message }); }
  if (!text || /^[\s.,!?-]*$/.test(text) || /^\[.*\]$/.test(text)) { post({ type: 'speech_cancel' }); return; }
  post({ type: 'transcript', text, sec: durSec, sttMs: Math.round(performance.now() - t0), prosody: prosody(audio, text) });
}

// ---------------- how you sounded ----------------
const base = { n: 0, db: -30, pitch: 160, wps: 2.6 };
function prosody(a, text) {
  const win = 480, voiced = [], dbs = [];
  for (let i = 0; i + win <= a.length; i += win) {
    let s = 0; for (let j = 0; j < win; j++) s += a[i + j] * a[i + j];
    const rms = Math.sqrt(s / win); const db = 20 * Math.log10(rms + 1e-9);
    if (db < -50) continue;
    dbs.push(db);
    const f0 = pitchOf(a.subarray(i, i + win * 2 > a.length ? a.length : i + win * 2));
    if (f0) voiced.push(f0);
  }
  const med = (x) => { if (!x.length) return 0; const s = [...x].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const db = dbs.length ? dbs.reduce((p, q) => p + q, 0) / dbs.length : -60;
  const pitch = med(voiced);
  const spread = voiced.length > 4 ? (med(voiced.map(v => Math.abs(v - pitch))) / (pitch || 1)) : 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const wps = words / Math.max(0.5, a.length / SR);
  const notes = [];
  if (base.n >= 3) {
    if (db > base.db + 4) notes.push('louder than usual'); else if (db < base.db - 5) notes.push('quieter than usual');
    if (pitch && pitch > base.pitch * 1.15) notes.push('higher pitched'); else if (pitch && pitch < base.pitch * 0.88) notes.push('lower pitched');
    if (wps > base.wps * 1.3) notes.push('talking fast'); else if (wps < base.wps * 0.7) notes.push('talking slowly');
  }
  if (spread && spread < 0.05 && voiced.length > 10) notes.push('flat, monotone');
  else if (spread > 0.2) notes.push('very animated');
  if (/\b(haha|hehe|lol|lmao)\b/i.test(text)) notes.push('laughing');
  const k = Math.min(base.n, 20);
  base.db = (base.db * k + db) / (k + 1); if (pitch) base.pitch = (base.pitch * k + pitch) / (k + 1); base.wps = (base.wps * k + wps) / (k + 1); base.n++;
  return notes.join(', ');
}
function pitchOf(x) {
  // Plain autocorrelation over 70 to 400 Hz.
  const n = x.length, minLag = Math.floor(SR / 400), maxLag = Math.floor(SR / 70);
  if (n < maxLag * 2) return 0;
  let e = 0; for (let i = 0; i < n - maxLag; i++) e += x[i] * x[i];
  if (e < 1e-4) return 0;
  let best = 0, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0; for (let i = 0; i < n - maxLag; i++) c += x[i] * x[i + lag];
    if (c > best) { best = c; bestLag = lag; }
  }
  return best / e > 0.45 ? SR / bestLag : 0;
}

// ---------------- speaking ----------------
let cancelledUpTo = 0, busy = 0, lastSpoke = 0;
// Background work (the little "mm-hmm" clips) waits until Orbit isn't talking, so it never delays real words.
async function idle() { while (busy || pending || performance.now() - lastSpoke < 4000) await new Promise(r => setTimeout(r, 400)); }
let pending = 0;
async function speak(m) { busy++; try { await speakNow(m); } finally { busy--; pending = Math.max(0, pending - 1); lastSpoke = performance.now(); } }
async function speakNow({ id, seq, text, speed }) {
  if (!ready) return;
  const gone = () => seq <= cancelledUpTo;
  // Split at sentence ends only where a space follows, so "2.4" or "e.g." stay whole.
  const parts = String(text).split(/(?<=[.!?…]["')\]]*)\s+/);
  for (const part of parts) {
    const t = part.trim(); if (!t) continue;
    if (gone()) return;
    try {
      if (engine === 'phonon') {
        // Stream: play the first ~240 ms as soon as it exists, then send bigger pieces.
        let batch = [], n = 0, first = true;
        const send = (last) => { if (!batch.length) return; const a = join(batch); batch = []; post({ type: 'audio', id, seq, text: first ? t : '', more: !last, pcm: a }, [a.buffer]); first = false; };
        for await (const f of phSpeak(t, gone)) { batch.push(f); n++; if (n >= (first ? 3 : 8)) { send(false); n = 0; } }
        if (gone()) return;
        send(true);
        continue;
      }
      const audio = await synth(t, speed || 1);
      if (gone()) return;
      post({ type: 'audio', id, seq, text: t, pcm: audio }, [audio.buffer]);
    } catch (e) { post({ type: 'error', message: 'Voice failed: ' + e.message }); }
  }
  if (!gone()) post({ type: 'spoken', id, seq });
}

let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { init(m).catch(err => post({ type: 'error', fatal: true, message: String(err && err.message || err) })); return; }
  if (m.type === 'audio') { chain = chain.then(() => feed(new Int16Array(m.pcm))).catch(err => post({ type: 'error', message: String(err.message || err) })); return; }
  if (m.type === 'playing') { playing = !!m.on; return; }
  if (m.type === 'speak') { pending++; speakQ = speakQ.then(() => speak(m)); return; }
  if (m.type === 'cancel') { cancelledUpTo = Math.max(cancelledUpTo, m.upTo || 0); return; }
  if (m.type === 'voice') { voice = m.voice; return; }
  if (m.type === 'phononVoice') { if (ph) speakQ = speakQ.then(() => phSetVoice(m.voice)).catch(() => {}); return; }
  if (m.type === 'endMs') { endMs = m.ms; return; }
  if (m.type === 'reset') { buf = new Float32Array(0); inSpeech = false; utter = []; preroll = []; speechMs = 0; silenceMs = 0; return; }
};
let speakQ = Promise.resolve();
