// Orbit Live: turns mic audio into 40 ms PCM16 chunks at the AudioContext's own rate (16 or 24 kHz).
class OrbitMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.04);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        const out = new Int16Array(this.size);
        let sum = 0;
        for (let j = 0; j < this.size; j++) {
          const v = Math.max(-1, Math.min(1, this.buf[j]));
          sum += v * v;
          out[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        this.port.postMessage({ pcm: out.buffer, rms: Math.sqrt(sum / this.size) }, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('orbit-mic', OrbitMic);
