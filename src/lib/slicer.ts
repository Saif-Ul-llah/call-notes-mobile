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
  /** Frames used to measure the background before detecting speech. */
  warmupMs: number
  /**
   * Speech is bursty; steady sound (fan hiss, a phone's auto-gain noise) is not.
   * "Speech" whose loudness varies less than this (coefficient of variation over
   * `steadyWindowMs`) is treated as background noise.
   */
  steadyCv: number
  steadyWindowMs: number
}

export const DEFAULT_SLICER_OPTIONS: SlicerOptions = {
  sampleRate: 16000,
  frameMs: 30,
  minSilenceMs: 450,
  maxSliceMs: 6000,
  minSpeechMs: 300,
  preRollMs: 300,
  tailMs: 250,
  partialEveryMs: 700,
  minRms: 0.004,
  speechRatio: 2.5,
  warmupMs: 300,
  steadyCv: 0.2,
  steadyWindowMs: 1500,
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
  private warmup: number[] = []
  private recentLevels: number[] = []

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

    // calibrate on the first few frames: never start a slice before we know the background
    if (this.warmup.length < this.framesFor(this.opts.warmupMs)) {
      this.warmup.push(level)
      const sorted = [...this.warmup].sort((a, b) => a - b)
      this.noiseFloor = Math.max(this.opts.minRms / 2, sorted[Math.floor(sorted.length / 2)])
      this.preRoll.push(frame)
      if (this.preRoll.length > this.framesFor(this.opts.preRollMs)) this.preRoll.shift()
      return null
    }

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
    this.recentLevels.push(level)
    if (this.recentLevels.length > this.framesFor(this.opts.steadyWindowMs)) this.recentLevels.shift()
    if (this.isSteady()) {
      // it was background noise all along: learn its level and drop the slice
      this.noiseFloor = this.recentLevels.reduce((a, b) => a + b, 0) / this.recentLevels.length
      this.inSpeech = false
      this.slice = []
      this.recentLevels = []
      this.speechRun = 0
      this.silenceRun = 0
      this.speechFrames = 0
      return null
    }
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
      const levels = this.recentLevels
      const ev = this.closeSlice(endSample)
      this.recentLevels = levels
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

  private isSteady(): boolean {
    const n = this.recentLevels.length
    if (n < this.framesFor(this.opts.steadyWindowMs)) return false
    const mean = this.recentLevels.reduce((a, b) => a + b, 0) / n
    const variance = this.recentLevels.reduce((a, b) => a + (b - mean) ** 2, 0) / n
    return Math.sqrt(variance) / Math.max(1e-9, mean) < this.opts.steadyCv
  }

  private closeSlice(endSample: number): SliceEvent | null {
    this.recentLevels = []
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
