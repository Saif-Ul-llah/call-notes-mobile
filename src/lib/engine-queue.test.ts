import { describe, expect, it } from 'vitest'
import { EngineQueue, MERGE_MAX_MS, takeChunk, type SliceJob, type WhisperLike } from './engine-queue'

const slice = (startMs: number, endMs: number, fill = 1000): SliceJob & { queuedAt: number } => ({
  startMs, endMs, pcm: new Int16Array((endMs - startMs) * 16).fill(fill), queuedAt: 0,
})

/** Fake whisper: answers with the slice's first sample after `delay(ms)`; records concurrency. */
function fakeWhisper(delay: (audioMs: number) => number, stats = { running: 0, peak: 0, calls: [] as number[] }): WhisperLike & { stats: typeof stats } {
  return {
    stats,
    transcribeData(data, opts) {
      const audioMs = data.byteLength / 32
      stats.calls.push(Number(opts.beamSize))
      stats.running++
      stats.peak = Math.max(stats.peak, stats.running)
      return {
        promise: new Promise((resolve) =>
          setTimeout(() => {
            stats.running--
            resolve({ result: `line ${new Int16Array(data)[0]}` })
          }, delay(audioMs)),
        ),
      }
    },
  }
}

const vad = { detectSpeechData: async (data: ArrayBuffer) => [{ t0: 0, t1: data.byteLength / 320 }] }

describe('takeChunk', () => {
  it('merges waiting slices up to the chunk limit, with a gap between them', () => {
    const q = [slice(0, 4000), slice(5000, 9000), slice(10000, 14000), slice(15000, 19000)]
    const job = takeChunk(q)!
    expect(job.startMs).toBe(0)
    expect(job.endMs).toBe(14000)
    expect(job.parts).toEqual([0, 5000, 10000])
    expect(job.pcm.length).toBe(3 * 4000 * 16 + 2 * 250 * 16)
    expect(q.map((j) => j.startMs)).toEqual([15000])
    expect(14000).toBeLessThanOrEqual(MERGE_MAX_MS)
  })

  it('returns a lone slice unchanged', () => {
    const q = [slice(0, 4000), slice(20000, 22000)]
    expect(takeChunk(q)!.parts).toBeUndefined()
    expect(q).toHaveLength(1)
  })
})

describe('EngineQueue', () => {
  it('delivers lines in order when a later one finishes first on another worker', async () => {
    const a = fakeWhisper((ms) => (ms > 2500 ? 120 : 10))
    const b = fakeWhisper(() => 10)
    const got: number[] = []
    const q = new EngineQueue(
      { getContexts: async () => ({ whisper: a, vad, workers: [b] }), decodeOptions: () => ({ beamSize: 3 }) },
      { onFinal: (job) => got.push(job.startMs), onPartial: () => undefined, onError: (e) => { throw e } },
    )
    q.pushFinal(slice(0, 3000, 1))
    await new Promise((r) => setTimeout(r, 2))
    q.pushFinal(slice(4000, 5000, 2))
    await new Promise((r) => setTimeout(r, 40))
    expect(got).toEqual([]) // line 2 is done but waits for line 1
    await q.drain()
    expect(got).toEqual([0, 4000])
  })

  it('splits a backlog between parallel workers', async () => {
    const stats = { running: 0, peak: 0, calls: [] as number[] }
    // the first line is slow, so the second worker finishes later lines first
    const a = fakeWhisper((ms) => (ms > 2500 ? 120 : 10), stats)
    const b = fakeWhisper(() => 10, stats)
    const got: number[] = []
    const merged: number[][] = []
    const q = new EngineQueue(
      { getContexts: async () => ({ whisper: a, vad, workers: [b] }), decodeOptions: (_k, _ms, behind) => ({ beamSize: behind ? 1 : 3 }) },
      { onFinal: (job) => (got.push(job.startMs), merged.push(job.parts ?? [job.startMs])), onPartial: () => undefined, onError: (e) => { throw e } },
    )
    q.pushFinal(slice(0, 3000, 1))
    q.pushFinal(slice(4000, 5000, 2))
    q.pushFinal(slice(6000, 7000, 3))
    await new Promise((r) => setTimeout(r, 5))
    await q.drain()
    // 3 waiting for 2 workers: one takes two slices as a chunk, the other the third
    expect(merged).toEqual([[0, 4000], [6000]])
    expect(got).toEqual([0, 6000])
    expect(stats.peak).toBe(2)
  })

  it('merges and decodes greedily once lines pile up, and drain waits for all of them', async () => {
    const stats = { running: 0, peak: 0, calls: [] as number[] }
    const w = fakeWhisper(() => 30, stats)
    const finals: Array<{ start: number; parts?: number[] }> = []
    const q = new EngineQueue(
      { getContexts: async () => ({ whisper: w, vad }), decodeOptions: (_k, _ms, behind) => ({ beamSize: behind ? 1 : 3 }) },
      { onFinal: (job) => finals.push({ start: job.startMs, parts: job.parts }), onPartial: () => undefined, onError: (e) => { throw e } },
    )
    for (let i = 0; i < 6; i++) q.pushFinal(slice(i * 3000, i * 3000 + 2000, i + 1))
    await new Promise((r) => setTimeout(r, 5))
    await q.drain()
    expect(q.pending).toBe(0)
    // first line alone (nothing was waiting yet), the rest in merged chunks
    expect(finals.length).toBeLessThan(6)
    expect(finals.flatMap((f) => f.parts ?? [f.start])).toEqual([0, 3000, 6000, 9000, 12000, 15000])
    expect(stats.calls).toContain(1)
  })

  it('skips previews while lines are waiting', async () => {
    const w = fakeWhisper(() => 20)
    const preview = fakeWhisper(() => 5)
    const partials: number[] = []
    const q = new EngineQueue(
      { getContexts: async () => ({ whisper: w, vad, preview }), decodeOptions: () => ({ beamSize: 1 }) },
      { onFinal: () => undefined, onPartial: (job) => partials.push(job.startMs), onError: (e) => { throw e } },
    )
    q.pushFinal(slice(0, 1000))
    q.pushFinal(slice(2000, 3000))
    q.offerPartial(slice(4000, 5000))
    await new Promise((r) => setTimeout(r, 5))
    expect(partials).toEqual([])
    await q.drain()
    await new Promise((r) => setTimeout(r, 30))
    expect(partials).toEqual([4000])
  })
})
