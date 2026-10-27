// Long-recording evaluation of the mobile whisper path: slices a real recording with the
// live Slicer, then transcribes the finals one by one or merged into longer chunks, and
// writes timed text + CPU time to JSON (compare against a reference transcript).
//
//   LECTURE=<wav> WHISPER_NATIVE=../desktop/native/linux-x64-avx2/index.node \
//   LECTURE_MERGE_MS=0|12000 LECTURE_BEAM=3 LECTURE_THREADS=4 LECTURE_TEMP_INC=0.2 LECTURE_OUT=out.json \
//   npx vitest run src/lib/lecture-eval.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { cleanTranscript } from '../shared/romanizer'
import { CROP_PAD_AFTER_MS, CROP_PAD_BEFORE_MS, audioCtxFor } from '../shared/models'
import { cropToSpeech } from './crop'
import { FINAL_CTX_EXTRA_MS } from './decode'
import { Slicer } from './slicer'

const ROOT = join(__dirname, '..', '..')
const MODEL = join(ROOT, 'assets', 'models', 'ggml-hinglish-swift-q5_1.bin')
const VAD = join(ROOT, 'assets', 'models', 'ggml-silero-v5.1.2.bin')
const file = process.env.LECTURE
const env = (k: string, d: number) => Number(process.env[k] ?? d)

function readWav16k(buf: Buffer): Int16Array {
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') return new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size))
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

describe.skipIf(!file || !process.env.WHISPER_NATIVE)('lecture eval (mobile)', () => {
  it('transcribes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(process.env.WHISPER_NATIVE!)
    const whisper = await new mod.WhisperContext({ filePath: MODEL, useGpu: false })
    const vad = await new mod.WhisperVadContext({ filePath: VAD, useGpu: false, nThreads: 1 })
    const pcm = readWav16k(readFileSync(file!))
    const limit = Math.min(pcm.length, env('LECTURE_LIMIT_MS', Infinity) * 16)

    const slicerOpts = process.env.LECTURE_SLICER ? JSON.parse(process.env.LECTURE_SLICER) : {}
    const slicer = new Slicer(slicerOpts)
    const slices: Array<{ startMs: number; endMs: number; audio: Int16Array }> = []
    for (let o = 0; o < limit; o += 1600) for (const ev of slicer.push(pcm.subarray(o, Math.min(limit, o + 1600)))) if (ev.type === 'final') slices.push(ev)
    for (const ev of slicer.flush()) slices.push(ev)

    // optionally merge neighbouring slices (what a backlog lets the queue do)
    const mergeMs = env('LECTURE_MERGE_MS', 0)
    const jobs: typeof slices = []
    for (const s of slices) {
      const last = jobs[jobs.length - 1]
      if (last && mergeMs > 0 && s.endMs - last.startMs <= mergeMs) {
        last.endMs = s.endMs
        last.audio = pcm.slice(last.startMs * 16, s.endMs * 16)
      } else jobs.push({ ...s })
    }

    const beam = env('LECTURE_BEAM', 3)
    const threads = env('LECTURE_THREADS', 4)
    const extra = env('LECTURE_CTX_EXTRA_MS', FINAL_CTX_EXTRA_MS)
    const out: Array<{ start: number; end: number; ms: number; text: string }> = []
    let proc = 0
    for (const j of jobs) {
      const full = j.audio.slice().buffer as ArrayBuffer
      const t = Date.now()
      const speech = await vad.detectSpeechData(full, { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100 })
      let text = ''
      if (speech.length) {
        const audio = cropToSpeech(full, speech, CROP_PAD_BEFORE_MS, CROP_PAD_AFTER_MS)
        const { promise } = whisper.transcribeData(audio, {
          language: 'en', temperature: 0, temperatureInc: env('LECTURE_TEMP_INC', 0.2), beamSize: beam, bestOf: beam, maxThreads: threads,
          audioCtx: audioCtxFor(audio.byteLength / 32 + extra),
        })
        text = cleanTranscript((await promise).result)
      }
      const ms = Date.now() - t
      proc += ms
      out.push({ start: j.startMs, end: j.endMs, ms, text })
    }
    const audioMs = limit / 16
    console.log(`slices=${slices.length} jobs=${jobs.length} proc=${proc}ms audio=${audioMs}ms rtf=${(proc / audioMs).toFixed(3)}`)
    writeFileSync(process.env.LECTURE_OUT ?? 'lecture.json', JSON.stringify({ mergeMs, beam, threads, proc, audioMs, chunks: out }, null, 1))
    await whisper.release()
    await vad.release()
  }, 7_200_000)
})
