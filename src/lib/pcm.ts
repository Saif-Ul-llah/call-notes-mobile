// Pure PCM conversion helpers (unit tested): any rate / channel count / encoding
// from the microphone -> 16 kHz mono int16 for whisper.

const TARGET_RATE = 16000

export function toPcm16kMono(data: ArrayBuffer, sampleRate: number, channels: number, encoding: 'int16' | 'float32'): Uint8Array {
  const src = encoding === 'float32' ? new Float32Array(data) : new Int16Array(data)
  const scale = encoding === 'float32' ? 32767 : 1
  const frames = Math.floor(src.length / channels)

  if (sampleRate === TARGET_RATE && channels === 1 && encoding === 'int16') {
    return new Uint8Array(data.slice(0, frames * 2))
  }

  const ratio = sampleRate / TARGET_RATE
  const outLen = Math.floor(frames / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    // box filter over the source frames covered by this output sample (cheap anti-aliasing)
    const from = Math.floor(i * ratio)
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio))
    let sum = 0
    let n = 0
    for (let f = from; f < to && f < frames; f++) {
      for (let c = 0; c < channels; c++) sum += src[f * channels + c] * scale
      n += channels
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sum / Math.max(1, n))))
  }
  return new Uint8Array(out.buffer)
}
