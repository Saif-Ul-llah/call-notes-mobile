// Trim a slice to the speech Silero VAD found in it. Leading/trailing non-speech is
// where whisper (especially the small Hinglish model) invents filler words.

/** VAD segment times are in centiseconds (whisper.cpp convention). */
export interface SpeechSpan {
  t0: number
  t1: number
}

const BYTES_PER_MS = 32 // 16 kHz * 16-bit mono

// padding tuned on the golden clips: 250/400 ms clipped word edges, 800+ ms let filler words back in
export function cropToSpeech(pcm: ArrayBuffer, speech: SpeechSpan[], padBeforeMs = 450, padAfterMs = 750): ArrayBuffer {
  if (speech.length === 0) return pcm
  const startMs = Math.max(0, Math.min(...speech.map((s) => s.t0)) * 10 - padBeforeMs)
  const endMs = Math.max(...speech.map((s) => s.t1)) * 10 + padAfterMs
  const start = Math.floor(startMs) * BYTES_PER_MS
  const end = Math.min(pcm.byteLength, Math.ceil(endMs) * BYTES_PER_MS)
  if (start <= 0 && end >= pcm.byteLength) return pcm
  return pcm.slice(start, end)
}
