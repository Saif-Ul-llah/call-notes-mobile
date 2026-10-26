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
  getContexts(): Promise<{ whisper: WhisperLike; vad: VadLike }>
  /** whisper options for a job kind (language, beam size, encoder window…) */
  decodeOptions(kind: 'final' | 'partial', audioMs: number): Record<string, unknown>
}

const toBuffer = (pcm: Int16Array): ArrayBuffer => pcm.slice().buffer as ArrayBuffer

export class EngineQueue {
  private finals: Array<SliceJob & { queuedAt: number }> = []
  private partial: (SliceJob & { queuedAt: number }) | null = null
  private running = false
  private closed = false
  private idleWaiters: Array<() => void> = []
  /** slices whose final was queued: late partials for them are ignored */
  private finalized = new Set<number>()

  constructor(private deps: QueueDeps, private handlers: QueueHandlers) {}

  get pending(): number {
    return this.finals.length
  }

  pushFinal(job: SliceJob): void {
    if (this.closed) return
    this.finalized.add(job.startMs)
    if (this.partial?.startMs === job.startMs) this.partial = null
    this.finals.push({ ...job, queuedAt: Date.now() })
    void this.pump()
  }

  offerPartial(job: SliceJob): void {
    if (this.closed || this.finalized.has(job.startMs)) return
    this.partial = { ...job, queuedAt: Date.now() } // newest preview replaces an older one
    void this.pump()
  }

  /** Resolves once every queued final has been transcribed. */
  drain(): Promise<void> {
    if (!this.running && this.finals.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  close(): void {
    this.closed = true
    this.partial = null
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const final = this.finals.shift()
        if (final) {
          await this.runFinal(final)
          continue
        }
        const partial = this.partial
        this.partial = null
        if (!partial || this.closed) break
        await this.runPartial(partial)
      }
    } finally {
      this.running = false
      if (this.finals.length === 0) this.idleWaiters.splice(0).forEach((r) => r())
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
      const { whisper } = await this.deps.getContexts()
      const { result } = await whisper.transcribeData(toBuffer(job.pcm), this.deps.decodeOptions('partial', job.pcm.length / 16)).promise
      // the slice may have been finalized while this preview was decoding
      if (!this.finalized.has(job.startMs)) this.handlers.onPartial(job, cleanTranscript(result), Date.now() - job.queuedAt)
    } catch (err) {
      this.handlers.onError(err, 'partial')
    }
  }
}
