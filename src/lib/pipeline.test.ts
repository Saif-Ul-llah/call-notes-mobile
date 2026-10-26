// Offline end-to-end test of the mobile live pipeline (Slicer -> EngineQueue -> romanizer)
// on real speech, using whisper.node: the same whisper.cpp + API that whisper.rn wraps.
// Audio is fed at real-time pace in 100 ms chunks, exactly like the microphone.
//
// Run (from a checkout next to call-notes-desktop, after its `npm install` and `npm run build-native`):
//   PIPELINE=1 WHISPER_NATIVE=../desktop/native/linux-x64-avx2/index.node npx vitest run src/lib/pipeline.test.ts
//   STRICT_LATENCY=1 to fail on slow previews/finals instead of only reporting them
// WHISPER_NATIVE can be any whisper.node addon (e.g. node_modules/@fugood/node-whisper-<platform>/index.node).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeOptions } from './decode'
import { EngineQueue, type SliceJob } from './engine-queue'
import { Slicer } from './slicer'

const ROOT = join(__dirname, '..', '..')
const AUDIO = join(ROOT, 'test-audio')
const MODEL = join(ROOT, 'assets', 'models', 'ggml-hinglish-swift-q5_1.bin')
const VAD = join(ROOT, 'assets', 'models', 'ggml-silero-v5.1.2.bin')
const NATIVE = process.env.WHISPER_NATIVE
const enabled = process.env.PIPELINE === '1' && existsSync(MODEL) && !!NATIVE && existsSync(NATIVE)

/** Any WAV (PCM16/float32, any rate/channels) -> 16 kHz mono int16. */
function decodeWav(buf: Buffer): Int16Array {
  let off = 12
  let fmt = { format: 1, channels: 1, rate: 16000, bits: 16 }
  let data: Buffer | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
    else if (id === 'data') data = buf.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size % 2)
  }
  if (!data) throw new Error('no data chunk')
  const bytes = fmt.bits / 8
  const frames = Math.floor(data.length / (bytes * fmt.channels))
  const ratio = fmt.rate / 16000
  const out = new Int16Array(Math.floor(frames / ratio))
  for (let i = 0; i < out.length; i++) {
    const f = Math.floor(i * ratio)
    let s = 0
    for (let c = 0; c < fmt.channels; c++) {
      const p = (f * fmt.channels + c) * bytes
      s += fmt.format === 3 ? data.readFloatLE(p) : data.readInt16LE(p) / 32768
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round((s / fmt.channels) * 32767)))
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).join(' ')
function cer(ref: string, hyp: string): number {
  const a = norm(ref)
  const b = norm(hyp)
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length] / Math.max(1, a.length)
}

describe.skipIf(!enabled)('live pipeline on real speech', () => {
  it('streams previews during speech and commits every utterance after it ends', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(NATIVE!)
    const whisper = await new mod.WhisperContext({ filePath: MODEL, useGpu: false })
    const vad = await new mod.WhisperVadContext({ filePath: VAD, useGpu: false, nThreads: 1 })

    // build a "call": 1 s quiet, then each clip followed by 1.5 s quiet
    const refs: Record<string, string> = JSON.parse(readFileSync(join(AUDIO, 'references.json'), 'utf8')).clips
    const quiet = (ms: number) => Int16Array.from({ length: ms * 16 }, () => Math.round((Math.random() - 0.5) * 60))
    const parts: Int16Array[] = [quiet(1000)]
    const utterances: Array<{ ref: string; startMs: number; endMs: number }> = []
    let cursor = 1000
    for (const [file, ref] of Object.entries(refs)) {
      const pcm = decodeWav(readFileSync(join(AUDIO, file)))
      utterances.push({ ref, startMs: cursor, endMs: cursor + pcm.length / 16 })
      cursor += pcm.length / 16 + 1500
      parts.push(pcm, quiet(1500))
    }
    const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
    parts.reduce((o, p) => (all.set(p, o), o + p.length), 0)

    const t0 = Date.now()
    const audioNow = () => Date.now() - t0 // feed is real-time: wall clock == audio clock
    const partials: Array<{ atMs: number; job: SliceJob; text: string }> = []
    const finals: Array<{ atMs: number; job: SliceJob; text: string }> = []
    const errors: unknown[] = []
    const queue = new EngineQueue(
      { getContexts: async () => ({ whisper, vad }), decodeOptions: (kind, ms) => ({ ...decodeOptions('roman', kind, ms), maxThreads: 4 }) },
      {
        onFinal: (job, text) => finals.push({ atMs: audioNow(), job, text }),
        onPartial: (job, text) => partials.push({ atMs: audioNow(), job, text }),
        onError: (err) => errors.push(err),
      },
    )
    const slicer = new Slicer()
    for (let off = 0; off < all.length; off += 1600) {
      for (const ev of slicer.push(all.subarray(off, off + 1600))) {
        const job = { startMs: ev.startMs, endMs: ev.endMs, pcm: ev.audio }
        if (ev.type === 'final') queue.pushFinal(job)
        else queue.offerPartial(job)
      }
      const due = t0 + (off / 16) + 100
      await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())))
    }
    for (const ev of slicer.flush()) queue.pushFinal({ startMs: ev.startMs, endMs: ev.endMs, pcm: ev.audio })
    await queue.drain()
    await whisper.release()
    await vad.release()

    // ---- report
    const lines: string[] = []
    let worstFirstPartial = 0
    let worstFinal = 0
    for (const u of utterances) {
      const mine = finals.filter((f) => f.job.startMs < u.endMs + 300 && f.job.endMs > u.startMs - 300 && f.text)
      const text = mine.map((f) => f.text).join(' ')
      const firstPartial = partials.find((p) => p.job.startMs < u.endMs && p.job.endMs > u.startMs && p.text)
      const firstPartialLag = firstPartial ? firstPartial.atMs - u.startMs : NaN
      const finalLag = mine.length ? Math.max(...mine.map((f) => f.atMs)) - u.endMs : NaN
      worstFirstPartial = Math.max(worstFirstPartial, firstPartialLag || 0)
      worstFinal = Math.max(worstFinal, finalLag || 0)
      lines.push(
        `utterance @${(u.startMs / 1000).toFixed(1)}s: first preview +${(firstPartialLag / 1000).toFixed(1)}s, final +${(finalLag / 1000).toFixed(1)}s after speech end, CER ${(cer(u.ref, text) * 100).toFixed(0)}%\n    ${text}`,
      )
      expect(text.length, `no final text for "${u.ref}"`).toBeGreaterThan(0)
      expect(cer(u.ref, text)).toBeLessThan(0.45)
      expect(text).toMatch(/^[\x20-\x7E]*$/)
    }
    console.log(`\n${lines.join('\n')}\npreviews: ${partials.length}, finals: ${finals.length}, errors: ${errors.length}`)
    expect(errors).toEqual([])
    expect(partials.length).toBeGreaterThan(0)
    if (process.env.STRICT_LATENCY === '1') {
      expect(worstFirstPartial).toBeLessThan(2500)
      expect(worstFinal).toBeLessThan(3000)
    }
  }, 300_000)
})
