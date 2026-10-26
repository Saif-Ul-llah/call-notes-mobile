import { describe, expect, it } from 'vitest'
import { Slicer } from './slicer'

const SR = 16000

function tone(ms: number, amp = 0.3, freq = 220): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp * 32767)
  return out
}

function noise(ms: number, amp = 0.001): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round((Math.random() * 2 - 1) * amp * 32767)
  return out
}

function feed(slicer: Slicer, parts: Int16Array[], chunkMs = 100) {
  const events = []
  for (const part of parts) {
    const step = (SR * chunkMs) / 1000
    for (let i = 0; i < part.length; i += step) events.push(...slicer.push(part.subarray(i, i + step)))
  }
  return events
}

describe('Slicer', () => {
  it('emits one final slice per utterance separated by silence', () => {
    const slicer = new Slicer({ minSilenceMs: 700 })
    const events = feed(slicer, [noise(1000), tone(1500), noise(1200), tone(1000), noise(1200)])
    const finals = events.filter((e) => e.type === 'final')
    expect(finals).toHaveLength(2)
    expect(finals[0].startMs).toBeGreaterThan(600)
    expect(finals[0].startMs).toBeLessThan(1100)
    expect(finals[0].endMs).toBeGreaterThan(2400)
    expect(finals[1].startMs).toBeGreaterThan(3300)
  })

  it('emits partials during long speech and splits at maxSliceMs', () => {
    const slicer = new Slicer({ maxSliceMs: 5000, partialEveryMs: 1000 })
    const events = feed(slicer, [noise(500), tone(12000), noise(1500)])
    const finals = events.filter((e) => e.type === 'final')
    const partials = events.filter((e) => e.type === 'partial')
    expect(finals.length).toBe(3)
    expect(partials.length).toBeGreaterThanOrEqual(6)
    // slices are contiguous
    expect(finals[1].startMs).toBe(finals[0].endMs)
  })

  it('ignores clicks shorter than minSpeechMs', () => {
    const slicer = new Slicer()
    const events = feed(slicer, [noise(1000), tone(150), noise(1500)])
    expect(events.filter((e) => e.type === 'final')).toHaveLength(0)
  })

  it('adapts to a loud noise floor', () => {
    const slicer = new Slicer()
    const events = feed(slicer, [noise(3000, 0.02), noise(3000, 0.02)])
    expect(events.filter((e) => e.type === 'final')).toHaveLength(0)
  })

  it('flush closes an open slice', () => {
    const slicer = new Slicer()
    feed(slicer, [noise(500), tone(2000)])
    const out = slicer.flush()
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('final')
  })
})
