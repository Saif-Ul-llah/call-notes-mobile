// Microphone capture with expo-audio's native PCM AudioStream.
// float32 is the stream's native format on both platforms; we convert to
// 16 kHz mono int16 ourselves (the requested rate is only a hint to the hardware).

import { AudioModule } from 'expo-audio'
import type { AudioStreamBuffer } from 'expo-audio'
import { log, updateDiagnostics } from './diagnostics'
import { toPcm16kMono } from './pcm'

type NativeStream = InstanceType<typeof AudioModule.AudioStream>

export class Mic {
  private stream: NativeStream | null = null
  private subs: Array<{ remove(): void }> = []
  private chunks = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private level = 0
  private lastLevelAt = 0

  constructor(private onPcm: (pcm: Int16Array) => void) {}

  async start(): Promise<void> {
    await this.stop()
    const stream = new AudioModule.AudioStream({ sampleRate: 16000, channels: 1, encoding: 'float32' })
    this.subs.push(stream.addListener('audioStreamBuffer', (buf: AudioStreamBuffer) => this.onBuffer(buf)))
    this.stream = stream
    await stream.start()
    log('info', `mic started (requested 16000 Hz, actual ${stream.sampleRate} Hz, ${stream.channels} ch)`)
    updateDiagnostics({ micSampleRate: stream.sampleRate, micChannels: stream.channels })
    this.statsTimer = setInterval(() => {
      updateDiagnostics({ chunksPerSec: this.chunks })
      this.chunks = 0
    }, 1000)
  }

  async stop(): Promise<void> {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
    this.subs.forEach((s) => s.remove())
    this.subs = []
    const stream = this.stream
    this.stream = null
    try {
      stream?.stop()
      stream?.release()
    } catch {
      /* already released */
    }
    updateDiagnostics({ level: 0, chunksPerSec: 0 })
  }

  private onBuffer(buf: AudioStreamBuffer): void {
    this.chunks++
    const bytes = toPcm16kMono(buf.data, buf.sampleRate, buf.channels, 'float32')
    if (bytes.length < 2) return
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1)
    this.meter(pcm)
    this.onPcm(pcm)
  }

  /** Smoothed RMS level for the UI meter, published ~15 times a second. */
  private meter(pcm: Int16Array): void {
    let sum = 0
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
    const rms = Math.sqrt(sum / pcm.length) / 32768
    // perceptual-ish scale: speech at ~-30 dBFS lands mid-meter
    const value = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-6) + 60) / 50))
    this.level = Math.max(value, this.level * 0.85)
    const now = Date.now()
    if (now - this.lastLevelAt > 66) {
      this.lastLevelAt = now
      updateDiagnostics({ level: this.level })
    }
  }
}
