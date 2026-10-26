import { describe, expect, it } from 'vitest'
import { cropToSpeech } from './crop'

const pcmOfMs = (ms: number) => new ArrayBuffer(ms * 32)

describe('cropToSpeech', () => {
  it('trims to the speech span plus padding', () => {
    // 10 s slice, speech from 2.0 s to 5.0 s (centiseconds)
    const out = cropToSpeech(pcmOfMs(10000), [{ t0: 200, t1: 500 }], 500, 500)
    expect(out.byteLength / 32).toBe(4000) // 1.5 s .. 5.5 s
  })

  it('covers all speech segments', () => {
    const out = cropToSpeech(pcmOfMs(10000), [{ t0: 300, t1: 400 }, { t0: 100, t1: 150 }], 0, 0)
    expect(out.byteLength / 32).toBe(3000)
  })

  it('clamps to the slice bounds and keeps the original when nothing to trim', () => {
    const pcm = pcmOfMs(3000)
    expect(cropToSpeech(pcm, [{ t0: 10, t1: 290 }], 500, 500)).toBe(pcm)
    expect(cropToSpeech(pcm, [])).toBe(pcm)
  })

  it('keeps sample alignment (even byte length)', () => {
    const out = cropToSpeech(pcmOfMs(5000), [{ t0: 123, t1: 321 }], 333, 777)
    expect(out.byteLength % 2).toBe(0)
  })
})
