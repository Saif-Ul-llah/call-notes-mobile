import { describe, expect, it } from 'vitest'
import { toPcm16kMono } from './pcm'
import { BYTES_PER_MS, HEADER_BYTES, gapFillBytes, tailWindows, wavHeader } from './wav'

describe('toPcm16kMono', () => {
  it('passes 16 kHz mono int16 through unchanged', () => {
    const src = new Int16Array([1, -2, 300, -400])
    const out = new Int16Array(toPcm16kMono(src.buffer, 16000, 1, 'int16').buffer)
    expect(Array.from(out)).toEqual([1, -2, 300, -400])
  })

  it('downsamples 48 kHz to 16 kHz by averaging', () => {
    const src = new Int16Array([3, 3, 3, 9, 9, 9])
    const out = new Int16Array(toPcm16kMono(src.buffer, 48000, 1, 'int16').buffer)
    expect(Array.from(out)).toEqual([3, 9])
  })

  it('mixes stereo to mono', () => {
    const src = new Int16Array([100, 300, -100, -300])
    const out = new Int16Array(toPcm16kMono(src.buffer, 16000, 2, 'int16').buffer)
    expect(Array.from(out)).toEqual([200, -200])
  })

  it('converts float32 to int16 with clipping', () => {
    const src = new Float32Array([0.5, -2])
    const out = new Int16Array(toPcm16kMono(src.buffer, 16000, 1, 'float32').buffer)
    expect(Array.from(out)).toEqual([16384, -32768])
  })
})

describe('wav helpers', () => {
  it('writes a valid 16 kHz mono header', () => {
    const h = wavHeader(32000)
    const v = new DataView(h.buffer)
    expect(String.fromCharCode(...h.slice(0, 4))).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 32000)
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(40, true)).toBe(32000)
  })

  it('plans tail windows after the last transcribed segment', () => {
    const fileBytes = HEADER_BYTES + 60000 * BYTES_PER_MS // 60 s recording
    const w = tailWindows(fileBytes, 20000, 25000)
    expect(w.map((x) => x.startMs)).toEqual([20000, 45000])
    expect(w[0].offset).toBe(HEADER_BYTES + 20000 * BYTES_PER_MS)
    expect(w[1].length).toBe(15000 * BYTES_PER_MS)
  })

  it('ignores a sub-second remainder and empty files', () => {
    expect(tailWindows(HEADER_BYTES + 400 * BYTES_PER_MS, 0)).toEqual([])
    expect(tailWindows(10, 0)).toEqual([])
  })

  it('caps gap filling', () => {
    expect(gapFillBytes(1000)).toBe(1000 * BYTES_PER_MS)
    expect(gapFillBytes(-5)).toBe(0)
    expect(gapFillBytes(60 * 60 * 1000)).toBe(5 * 60 * 1000 * BYTES_PER_MS)
  })
})
