// Copy of desktop/src/main/pipeline/slicer.ts with mobile defaults tuned for latency.
// Energy-based voice activity slicer with an adaptive noise floor.
// Cuts a continuous 16 kHz mono stream into speech slices: a slice closes after
// `minSilenceMs` of silence or at `maxSliceMs`. While speech continues it emits
// "partial" snapshots so the UI can show text before the sentence ends.
// Final slices are re-checked with Silero VAD in the engine before transcription.

export interface SlicerOptions {
  sampleRate: number
  frameMs: number
  minSilenceMs: number
  maxSliceMs: number
  minSpeechMs: number
  preRollMs: number
  tailMs: number
  partialEveryMs: number
  /** Absolute RMS floor (0..1) below which audio is never speech. */
  minRms: number
  /** Speech when RMS > noiseFloor * ratio. */
  speechRatio: number
}

export const DEFAULT_SLICER_OPTIONS: SlicerOptions = {
  sampleRate: 16000,
  frameMs: 30,
  minSilenceMs: 550,
  maxSliceMs: 8000,
  minSpeechMs: 300,
  preRollMs: 300,
  tailMs: 250,
  partialEveryMs: 900,
  minRms: 0.004,
  speechRatio: 2.5,
}

export interface SliceEvent {
  type: 'partial' | 'final'
  audio: Int16Array
  /** ms from the start of the stream */
  startMs: number
  endMs: number
}

export class Slicer {
  private opts: SlicerOptions
  private frameSamples: number
  private pending = new Int16Array(0)
  private sampleCursor = 0 // samples consumed into frames so far

  private noiseFloor: number
  private inSpeech = false
  private speechRun = 0 // consecutive speech frames before start
  private silenceRun = 0 // consecutive silent frames while in speech
  private speechFrames = 0
  private preRoll: Int16Array[] = []
  private slice: Int16Array[] = []
  private sliceStartSample = 0
  private lastPartialAtSample = 0

  constructor(options: Partial<SlicerOptions> = {}) {
    this.opts = { ...DEFAULT_SLICER_OPTIONS, ...options }
    this.frameSamples = Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000)
    this.noiseFloor = this.opts.minRms
  }

  private ms(samples: number): number {
    return Math.round((samples * 1000) / this.opts.sampleRate)
  }

  private framesFor(ms: number): number {
    return Math.max(1, Math.round(ms / this.opts.frameMs))
  }

  private static rms(frame: Int16Array): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i] / 32768
      sum += v * v
    }
    return Math.sqrt(sum / frame.length)
  }

  private static concat(parts: Int16Array[]): Int16Array {
    const total = parts.reduce((n, p) => n + p.length, 0)
    const out = new Int16Array(total)
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return out
  }

  push(pcm: Int16Array): SliceEvent[] {
    const events: SliceEvent[] = []
    const merged = new Int16Array(this.pending.length + pcm.length)
    merged.set(this.pending)
    merged.set(pcm, this.pending.length)
    let off = 0
    while (off + this.frameSamples <= merged.length) {
      const frame = merged.slice(off, off + this.frameSamples)
      off += this.frameSamples
      const ev = this.processFrame(frame)
      if (ev) events.push(ev)
      this.sampleCursor += this.frameSamples
    }
    this.pending = merged.slice(off)
    return events
  }

  private processFrame(frame: Int16Array): SliceEvent | null {
    const level = Slicer.rms(frame)
    const threshold = Math.max(this.opts.minRms, this.noiseFloor * this.opts.speechRatio)
    const isSpeech = level > threshold

    if (!this.inSpeech) {
      // track background noise only outside speech; rise slowly, fall quickly
      const k = level > this.noiseFloor ? 0.02 : 0.2
      this.noiseFloor = Math.max(this.opts.minRms / 2, this.noiseFloor + (level - this.noiseFloor) * k)

      this.preRoll.push(frame)
      if (this.preRoll.length > this.framesFor(this.opts.preRollMs)) this.preRoll.shift()
      this.speechRun = isSpeech ? this.speechRun + 1 : 0
      if (this.speechRun >= 3) {
        this.inSpeech = true
        this.slice = [...this.preRoll]
        this.preRoll = []
        this.sliceStartSample = this.sampleCursor + this.frameSamples - this.slice.length * this.frameSamples
        this.lastPartialAtSample = this.sliceStartSample
        this.speechFrames = this.speechRun
        this.silenceRun = 0
      }
      return null
    }

    this.slice.push(frame)
    if (isSpeech) {
      this.speechFrames++
      this.silenceRun = 0
    } else {
      this.silenceRun++
    }
    const endSample = this.sampleCursor + this.frameSamples
    const sliceMs = this.ms(endSample - this.sliceStartSample)

    if (this.silenceRun >= this.framesFor(this.opts.minSilenceMs)) {
      // drop most of the trailing silence, keep a short tail
      const dropFrames = Math.max(0, this.silenceRun - this.framesFor(this.opts.tailMs))
      this.slice.splice(this.slice.length - dropFrames, dropFrames)
      return this.closeSlice(endSample - dropFrames * this.frameSamples)
    }
    if (sliceMs >= this.opts.maxSliceMs) {
      const ev = this.closeSlice(endSample)
      // speech continues straight into the next slice
      this.inSpeech = true
      this.slice = []
      this.sliceStartSample = endSample
      this.lastPartialAtSample = endSample
      this.speechFrames = 0
      this.silenceRun = 0
      return ev
    }
    if (this.ms(endSample - this.lastPartialAtSample) >= this.opts.partialEveryMs) {
      this.lastPartialAtSample = endSample
      return { type: 'partial', audio: Slicer.concat(this.slice), startMs: this.ms(this.sliceStartSample), endMs: this.ms(endSample) }
    }
    return null
  }

  private closeSlice(endSample: number): SliceEvent | null {
    const audio = Slicer.concat(this.slice)
    const speechMs = this.speechFrames * this.opts.frameMs
    const startMs = this.ms(this.sliceStartSample)
    this.inSpeech = false
    this.slice = []
    this.speechRun = 0
    this.silenceRun = 0
    this.speechFrames = 0
    if (speechMs < this.opts.minSpeechMs) return null
    return { type: 'final', audio, startMs, endMs: this.ms(endSample) }
  }

  /** Close any open slice (on stop / stream restart). */
  flush(): SliceEvent[] {
    if (!this.inSpeech || this.slice.length === 0) {
      this.inSpeech = false
      this.slice = []
      return []
    }
    const ev = this.closeSlice(this.sampleCursor)
    return ev ? [ev] : []
  }

  get speaking(): boolean {
    return this.inSpeech
  }
}
