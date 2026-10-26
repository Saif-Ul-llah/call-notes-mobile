// Pure WAV helpers (no native deps) — unit tested.

export const SAMPLE_RATE = 16000
export const BYTES_PER_MS = 32 // 16 kHz * 16-bit mono
export const HEADER_BYTES = 44

export function wavHeader(dataBytes: number, sampleRate = SAMPLE_RATE): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES)
  const v = new DataView(h.buffer)
  const ascii = (off: number, s: string) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, dataBytes, true)
  return h
}

/**
 * Plan the windows used to transcribe audio that a crash left untranscribed:
 * from `fromMs` to the end of the recording, in windows of at most `windowMs`.
 * Returns byte ranges into the WAV file (header included in offsets).
 */
export function tailWindows(fileBytes: number, fromMs: number, windowMs = 25000): Array<{ startMs: number; offset: number; length: number }> {
  const dataBytes = Math.max(0, fileBytes - HEADER_BYTES)
  const totalMs = Math.floor(dataBytes / BYTES_PER_MS)
  const out: Array<{ startMs: number; offset: number; length: number }> = []
  for (let start = Math.max(0, fromMs); start < totalMs; start += windowMs) {
    const end = Math.min(totalMs, start + windowMs)
    if (end - start < 500) break // ignore a sub-second remainder
    out.push({ startMs: start, offset: HEADER_BYTES + start * BYTES_PER_MS, length: (end - start) * BYTES_PER_MS })
  }
  return out
}

/** Bytes of silence that keep the recording aligned with the clock after a capture gap. */
export function gapFillBytes(gapMs: number, maxGapMs = 5 * 60 * 1000): number {
  return Math.round(Math.min(Math.max(0, gapMs), maxGapMs)) * BYTES_PER_MS
}
