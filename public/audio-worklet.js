/**
 * PCM AudioWorklet processor for mic capture.
 * Resamples input audio to 16kHz mono, converts Float32 to Int16,
 * and sends 80ms chunks (1280 samples) to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.targetSampleRate = 16000;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    // Resample from sampleRate to 16kHz
    const ratio = this.targetSampleRate / sampleRate;
    const resampled = new Float32Array(Math.floor(input.length * ratio));
    for (let i = 0; i < resampled.length; i++) {
      const srcIdx = i / ratio;
      const idx = Math.floor(srcIdx);
      const frac = srcIdx - idx;
      resampled[i] = idx + 1 < input.length
        ? input[idx] * (1 - frac) + input[idx + 1] * frac
        : input[idx];
    }

    // Accumulate
    const newBuf = new Float32Array(this.buffer.length + resampled.length);
    newBuf.set(this.buffer);
    newBuf.set(resampled, this.buffer.length);
    this.buffer = newBuf;

    // Send 80ms chunks (1280 samples at 16kHz)
    const chunkSize = 1280;
    while (this.buffer.length >= chunkSize) {
      const chunk = this.buffer.slice(0, chunkSize);
      this.buffer = this.buffer.slice(chunkSize);

      // Float32 to Int16
      const pcm = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
