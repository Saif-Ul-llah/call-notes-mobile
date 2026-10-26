// whisper.rn audio source backed by expo-audio's native PCM AudioStream.
// Every 16 kHz chunk is also handed to `tap` (the session's WAV writer) before
// it reaches the transcriber, so the recording never depends on transcription.

import { AudioModule } from 'expo-audio'
import type { AudioStreamBuffer } from 'expo-audio'
import type { AudioStreamConfig, AudioStreamData, AudioStreamInterface } from 'whisper.rn/src/realtime-transcription/types'
import { toPcm16kMono } from './pcm'

type NativeStream = InstanceType<typeof AudioModule.AudioStream>

export class ExpoAudioStream implements AudioStreamInterface {
  private stream: NativeStream | null = null
  private subs: Array<{ remove(): void }> = []
  private recording = false
  private dataCb?: (data: AudioStreamData) => void
  private errorCb?: (error: string) => void
  private statusCb?: (isRecording: boolean) => void

  constructor(private tap: (pcm: Uint8Array) => void) {}

  async initialize(_config: AudioStreamConfig): Promise<void> {
    await this.release()
    // 16 kHz is a request; the buffer carries the real rate and we resample if needed
    const stream = new AudioModule.AudioStream({ sampleRate: 16000, channels: 1, encoding: 'int16' })
    this.subs.push(
      stream.addListener('audioStreamBuffer', (buf: AudioStreamBuffer) => this.onBuffer(buf)),
      stream.addListener('audioStreamStatus', (s: { isStreaming: boolean }) => {
        this.recording = s.isStreaming
        this.statusCb?.(s.isStreaming)
      }),
    )
    this.stream = stream
  }

  async start(): Promise<void> {
    if (!this.stream) throw new Error('audio stream not initialised')
    try {
      await this.stream.start()
      this.recording = true
    } catch (err) {
      this.errorCb?.(`Audio start failed: ${err}`)
      throw err
    }
  }

  async stop(): Promise<void> {
    this.stream?.stop()
    this.recording = false
  }

  isRecording(): boolean {
    return this.recording
  }

  onData(cb: (data: AudioStreamData) => void): void {
    this.dataCb = cb
  }

  onError(cb: (error: string) => void): void {
    this.errorCb = cb
  }

  onStatusChange(cb: (isRecording: boolean) => void): void {
    this.statusCb = cb
  }

  async release(): Promise<void> {
    this.subs.forEach((s) => s.remove())
    this.subs = []
    try {
      this.stream?.stop()
      this.stream?.release()
    } catch {
      /* already released */
    }
    this.stream = null
    this.recording = false
  }

  private onBuffer(buf: AudioStreamBuffer): void {
    const pcm = toPcm16kMono(buf.data, buf.sampleRate, buf.channels, 'int16')
    if (pcm.length === 0) return
    try {
      this.tap(pcm)
    } catch (err) {
      this.errorCb?.(`Audio file write failed: ${err}`)
    }
    this.dataCb?.({ data: pcm, sampleRate: 16000, channels: 1, timestamp: Date.now() })
  }
}
