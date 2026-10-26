// Feeds speech slices to whisper one at a time (a whisper context is not re-entrant).
// Finals always win: they're Silero-gated, cropped to speech and decoded with beam
// search. Partials are best-effort previews: greedy, only the newest one is kept,
// and they're skipped while a final is waiting.
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
}

export interface QueueHandlers {
  onFinal(job: SliceJob, text: string, raw: string, latencyMs: number): void
  onPartial(job: SliceJob, text: string, latencyMs: number): void
  onError(error: unknown, kind: 'final' | 'partial'): void
}

export interface QueueDeps {
  /** `preview` is optional: without it previews share the line context (one job at a time) */
  getContexts(): Promise<{ whisper: WhisperLike; vad: VadLike; preview?: WhisperLike }>
  /** whisper options for a job kind (language, beam size, encoder window…) */
  decodeOptions(kind: 'final' | 'partial', audioMs: number): Record<string, unknown>
}

const toBuffer = (pcm: Int16Array): ArrayBuffer => pcm.slice().buffer as ArrayBuffer

export class EngineQueue {
  private finals: Array<SliceJob & { queuedAt: number }> = []
  private partial: (SliceJob & { queuedAt: number }) | null = null
  private finalsRunning = false
  private previewRunning = false
  private closed = false
  private idleWaiters: Array<() => void> = []
  /** slices whose final was queued: late partials for them are ignored */
  private finalized = new Set<number>()
  /** true once we know previews have a context of their own */
  private separatePreview = false

  constructor(private deps: QueueDeps, private handlers: QueueHandlers) {}

  get pending(): number {
    return this.finals.length + (this.finalsRunning ? 1 : 0)
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

  /** Resolves once every queued final has been transcribed. */
  drain(): Promise<void> {
    if (!this.finalsRunning && this.finals.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  close(): void {
    this.closed = true
    this.partial = null
  }

  private async runFinals(): Promise<void> {
    if (this.finalsRunning) return
    this.finalsRunning = true
    try {
      for (let job = this.finals.shift(); job; job = this.finals.shift()) await this.runFinal(job)
    } finally {
      this.finalsRunning = false
      this.idleWaiters.splice(0).forEach((r) => r())
      // previews that waited for a shared context can go now
      if (this.partial) void this.runPreviews()
    }
  }

  private async runPreviews(): Promise<void> {
    if (this.previewRunning) return
    // with one shared context a preview waits for lines (lines matter more)
    if (!this.separatePreview && this.finalsRunning) return
    this.previewRunning = true
    try {
      for (;;) {
        const job = this.partial
        this.partial = null
        if (!job || this.closed) break
        await this.runPartial(job)
        if (!this.separatePreview && this.finalsRunning) break
      }
    } finally {
      this.previewRunning = false
    }
  }

  private async runFinal(job: SliceJob & { queuedAt: number }): Promise<void> {
    try {
      const { whisper, vad } = await this.deps.getContexts()
      const full = toBuffer(job.pcm)
      const speech = await vad.detectSpeechData(full, { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100 })
      if (speech.length === 0) {
        this.handlers.onFinal(job, '', '', Date.now() - job.queuedAt)
        return
      }
      const audio = cropToSpeech(full, speech, CROP_PAD_BEFORE_MS, CROP_PAD_AFTER_MS)
      const { result } = await whisper.transcribeData(audio, this.deps.decodeOptions('final', audio.byteLength / 32)).promise
      this.handlers.onFinal(job, cleanTranscript(result), result, Date.now() - job.queuedAt)
    } catch (err) {
      this.handlers.onError(err, 'final')
    }
  }

  private async runPartial(job: SliceJob & { queuedAt: number }): Promise<void> {
    try {
      const ctx = await this.deps.getContexts()
      this.separatePreview = !!ctx.preview
      const whisper = ctx.preview ?? ctx.whisper
      const { result } = await whisper.transcribeData(toBuffer(job.pcm), this.deps.decodeOptions('partial', job.pcm.length / 16)).promise
      // the slice may have been finalized while this preview was decoding
      if (!this.finalized.has(job.startMs)) this.handlers.onPartial(job, cleanTranscript(result), Date.now() - job.queuedAt)
    } catch (err) {
      this.handlers.onError(err, 'partial')
    }
  }
}
