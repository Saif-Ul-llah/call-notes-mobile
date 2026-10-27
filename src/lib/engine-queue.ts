// Feeds speech slices to whisper. A whisper context is not re-entrant, so each worker owns
// one; with several contexts, lines are transcribed in parallel and still delivered in
// order. Finals always win: they're Silero-gated, cropped to speech and decoded with beam
// search. Partials are best-effort previews: greedy, only the newest one is kept.
//
// Keeping up on slow phones: when lines pile up, a worker takes several waiting slices as
// one chunk (one encoder pass instead of many, and more context, which whisper needs for
// accuracy), decodes greedily, and previews pause until the backlog is gone.
// Pure TypeScript with injected contexts, so it is tested on desktop with whisper.node.

import { cleanTranscript } from '../shared/romanizer'
import { CROP_PAD_AFTER_MS, CROP_PAD_BEFORE_MS } from '../shared/models'
import { cropToSpeech } from './crop'

export interface WhisperLike {
  transcribeData(data: ArrayBuffer, options: Record<string, unknown>): { promise: Promise<{ result: string }> }
}

export interface VadLike {
  detectSpeechData(data: ArrayBuffer, options: Record<string, unknown>): Promise<Array<{ t0: number; t1: number }>>
}

export interface SliceJob {
  /** session-relative start of the slice; identifies the slice (partials and its final share it) */
  startMs: number
  endMs: number
  pcm: Int16Array
  /** start of every slice merged into this job (previews to clear) */
  parts?: number[]
}

export interface QueueHandlers {
  onFinal(job: SliceJob, text: string, raw: string, latencyMs: number): void
  onPartial(job: SliceJob, text: string, latencyMs: number): void
  onError(error: unknown, kind: 'final' | 'partial'): void
}

export interface Contexts {
  whisper: WhisperLike
  vad: VadLike
  /** previews run here so they never wait behind a line; without it they share `whisper` */
  preview?: WhisperLike
  /** extra contexts for transcribing lines in parallel */
  workers?: WhisperLike[]
}

export interface QueueDeps {
  getContexts(): Promise<Contexts>
  /** whisper options for a job kind (language, beam size, encoder window…); `behind` = far behind, go fast */
  decodeOptions(kind: 'final' | 'partial', audioMs: number, behind: boolean): Record<string, unknown>
}

/**
 * Waiting slices merged into one chunk span at most this much audio. On the lecture eval,
 * 10 s chunks cost about the same CPU as 15 s ones but halve how long a line waits.
 */
export const MERGE_MAX_MS = 10000
/** Silence put between merged slices so words don't run together. */
const MERGE_GAP_SAMPLES = 16 * 250
/** With more lines than this waiting, lines are decoded greedily (~20% faster, slightly less accurate). */
const FAR_BEHIND = 3
/** Previews pause while lines take longer than this × their audio to transcribe. */
const SLOW_RTF = 1

type Queued = SliceJob & { queuedAt: number }

const toBuffer = (pcm: Int16Array): ArrayBuffer => pcm.slice().buffer as ArrayBuffer

/** Join up to `maxCount` waiting slices from the front of the queue into one job (in place). */
export function takeChunk(queue: Queued[], maxCount = Infinity, maxMs = MERGE_MAX_MS): Queued | undefined {
  const first = queue.shift()
  if (!first) return undefined
  const group = [first]
  while (group.length < maxCount && queue.length > 0 && queue[0].endMs - first.startMs <= maxMs) group.push(queue.shift()!)
  if (group.length === 1) return first
  const total = group.reduce((n, j) => n + j.pcm.length, 0) + MERGE_GAP_SAMPLES * (group.length - 1)
  const pcm = new Int16Array(total)
  let at = 0
  for (const j of group) {
    pcm.set(j.pcm, at)
    at += j.pcm.length + MERGE_GAP_SAMPLES
  }
  return {
    startMs: first.startMs,
    endMs: group[group.length - 1].endMs,
    pcm,
    parts: group.flatMap((j) => j.parts ?? [j.startMs]),
    queuedAt: first.queuedAt,
  }
}

export class EngineQueue {
  private finals: Queued[] = []
  private partial: Queued | null = null
  /** contexts currently transcribing a line */
  private busy = new Set<WhisperLike>()
  private previewRunning = false
  private closed = false
  private idleWaiters: Array<() => void> = []
  /** slices whose final was queued: late partials for them are ignored */
  private finalized = new Set<number>()
  /** true once we know previews have a context of their own */
  private separatePreview = false
  /** lines are slower than real time: previews would only steal CPU from them */
  private slow = false
  // in-order delivery of lines finished by parallel workers
  private nextSeq = 0
  private emitSeq = 0
  private done = new Map<number, () => void>()
  private vadChain: Promise<unknown> = Promise.resolve()

  constructor(private deps: QueueDeps, private handlers: QueueHandlers) {}

  /** lines waiting or being transcribed */
  get pending(): number {
    return this.finals.length + this.busy.size
  }

  pushFinal(job: SliceJob): void {
    if (this.closed) return
    this.finalized.add(job.startMs)
    if (this.partial?.startMs === job.startMs) this.partial = null
    this.finals.push({ ...job, queuedAt: Date.now() })
    void this.runFinals()
  }

  offerPartial(job: SliceJob): void {
    if (this.closed || this.finalized.has(job.startMs)) return
    this.partial = { ...job, queuedAt: Date.now() } // newest preview replaces an older one
    void this.runPreviews()
  }

  /** Resolves once every queued final has been transcribed and delivered. */
  drain(): Promise<void> {
    if (this.idle()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  close(): void {
    this.closed = true
    this.partial = null
  }

  private idle() {
    return this.busy.size === 0 && this.finals.length === 0
  }

  private async runFinals(): Promise<void> {
    const ctx = await this.deps.getContexts().catch((err) => {
      this.handlers.onError(err, 'final')
      return null
    })
    if (!ctx) {
      // nothing can run: report the waiting lines as failed rather than hang drain()
      this.finals = []
      this.settle()
      return
    }
    const pool = [ctx.whisper, ...(ctx.workers ?? [])]
    // one loop per free context; each takes the next chunk when it finishes one
    for (const whisper of pool) {
      if (this.finals.length === 0) break
      if (this.busy.has(whisper)) continue
      this.busy.add(whisper)
      void this.worker(whisper, ctx.vad, pool.length)
    }
  }

  private async worker(whisper: WhisperLike, vad: VadLike, poolSize: number): Promise<void> {
    try {
      for (;;) {
        // Once lines wait, take several as one chunk (on a real lecture recording 10-15 s chunks
        // were both ~1.7x cheaper and more accurate than single lines), leaving a share of the
        // backlog for the other workers. Far behind, also drop beam search.
        const waiting = this.finals.length
        const job = waiting > 1 ? takeChunk(this.finals, Math.ceil(waiting / poolSize)) : this.finals.shift()
        if (!job) break
        const seq = this.nextSeq++
        const deliver = await this.runFinal(whisper, vad, job, waiting > FAR_BEHIND)
        this.done.set(seq, deliver)
        this.flushInOrder()
      }
    } finally {
      this.busy.delete(whisper)
      this.settle()
    }
  }

  private flushInOrder() {
    for (let d = this.done.get(this.emitSeq); d; d = this.done.get(this.emitSeq)) {
      this.done.delete(this.emitSeq++)
      d()
    }
  }

  private settle() {
    if (!this.idle()) return
    this.idleWaiters.splice(0).forEach((r) => r())
    // previews that waited for the lines can go now
    if (this.partial) void this.runPreviews()
  }

  private async runPreviews(): Promise<void> {
    if (this.previewRunning || this.slow) return
    // lines matter more: no previews while lines wait or while sharing the only context
    if (this.finals.length > 0 || (!this.separatePreview && this.busy.size > 0)) return
    this.previewRunning = true
    try {
      for (;;) {
        const job = this.partial
        this.partial = null
        if (!job || this.closed || this.slow) break
        await this.runPartial(job)
        if (this.finals.length > 0 || (!this.separatePreview && this.busy.size > 0)) break
      }
    } finally {
      this.previewRunning = false
    }
  }

  /** Serialize VAD calls: workers share one VAD context. */
  private detect(vad: VadLike, audio: ArrayBuffer) {
    const run = this.vadChain.then(() => vad.detectSpeechData(audio, { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100 }))
    this.vadChain = run.catch(() => undefined)
    return run
  }

  /** Transcribes a line and returns the callback that delivers it (called in order). */
  private async runFinal(whisper: WhisperLike, vad: VadLike, job: Queued, behind: boolean): Promise<() => void> {
    try {
      const full = toBuffer(job.pcm)
      const speech = await this.detect(vad, full)
      if (speech.length === 0) return () => this.handlers.onFinal(job, '', '', Date.now() - job.queuedAt)
      const audio = cropToSpeech(full, speech, CROP_PAD_BEFORE_MS, CROP_PAD_AFTER_MS)
      const audioMs = audio.byteLength / 32
      const t = Date.now()
      const { result } = await whisper.transcribeData(audio, this.deps.decodeOptions('final', audioMs, behind)).promise
      const rtf = (Date.now() - t) / Math.max(1000, audioMs)
      if (rtf > SLOW_RTF) this.slow = true
      else if (rtf < SLOW_RTF * 0.6) this.slow = false
      const text = cleanTranscript(result)
      return () => this.handlers.onFinal(job, text, result, Date.now() - job.queuedAt)
    } catch (err) {
      return () => this.handlers.onError(err, 'final')
    }
  }

  private async runPartial(job: Queued): Promise<void> {
    try {
      const ctx = await this.deps.getContexts()
      this.separatePreview = !!ctx.preview
      const whisper = ctx.preview ?? ctx.whisper
      const { result } = await whisper.transcribeData(toBuffer(job.pcm), this.deps.decodeOptions('partial', job.pcm.length / 16, false)).promise
      // the slice may have been finalized while this preview was decoding
      if (!this.finalized.has(job.startMs)) this.handlers.onPartial(job, cleanTranscript(result), Date.now() - job.queuedAt)
    } catch (err) {
      this.handlers.onError(err, 'partial')
    }
  }
}
