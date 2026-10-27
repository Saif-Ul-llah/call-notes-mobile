// Android's on-device speech recognizer (the offline engine behind Google voice typing)
// as the live engine. Our microphone PCM is streamed into it, so the WAV recording stays
// ours; it returns words while people talk and a line at every pause, in real time even
// on low-end phones where whisper can't keep up. Android 13+, language pack required.
//
// Hindi comes back in Devanagari; the romanizer turns it into Roman Urdu/Hindi.

import { Platform } from 'react-native'
import ForegroundService from '../../modules/call-notes-foreground'
import type { SpeechSupport } from '../../modules/call-notes-foreground/src/CallNotesForegroundServiceModule'
import type { LanguageMode } from '../shared/types'
import { log } from './diagnostics'

export type SystemSpeechStatus = 'ready' | 'downloading' | 'needs-download' | 'unsupported'

export const systemSpeechSupported = Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 33 && !!ForegroundService

/** Hindi covers spoken Urdu and Hinglish; Roman output comes from the romanizer. */
export function systemLocale(mode: LanguageMode): string {
  return mode === 'en' ? 'en-IN' : 'hi-IN'
}

const sameLocale = (a: string, b: string) => a.replace('_', '-').toLowerCase() === b.toLowerCase()

export async function systemSpeechStatus(mode: LanguageMode): Promise<SystemSpeechStatus> {
  if (!systemSpeechSupported) return 'unsupported'
  const locale = systemLocale(mode)
  try {
    const s = await ForegroundService!.speechSupport(locale)
    if (!s.onDevice) return 'unsupported'
    const status = statusOf(s, locale)
    // logged once per state change, so the shared log says why an engine was chosen
    const line = `android speech (${s.kind ?? '?'}) for ${locale}: ${status}; installed ${s.installed?.join(',') || 'none'}${s.error !== undefined ? `, check error ${s.error}` : ''}`
    if (line !== lastStatusLine) log('info', (lastStatusLine = line))
    return status
  } catch (err) {
    log('warn', `on-device speech check failed: ${err}`)
    return 'unsupported'
  }
}

let lastStatusLine = ''

function statusOf(s: SpeechSupport, locale: string): SystemSpeechStatus {
  // some recognizers can't report languages: try it, a failure falls back to whisper
  if (s.error !== undefined) return 'ready'
  if (s.installed?.some((l) => sameLocale(l, locale))) return 'ready'
  if (s.pending?.some((l) => sameLocale(l, locale))) return 'downloading'
  if (s.supported?.some((l) => sameLocale(l, locale))) return 'needs-download'
  return 'unsupported'
}

export function downloadSystemSpeech(mode: LanguageMode): Promise<void> {
  return ForegroundService?.speechDownload(systemLocale(mode)) ?? Promise.resolve()
}

export interface SystemSpeechHandlers {
  /** words of the line being spoken (replaces the previous partial) */
  onPartial(text: string): void
  /** a finished line (may be empty) */
  onSegment(text: string): void
  /** the recognizer can't be used: switch to whisper */
  onFatal(reason: string): void
}

// errors that won't go away by restarting the session
const FATAL = new Set(['language-not-supported', 'language-not-downloaded', 'permissions'])
// a quiet room ends sessions with these; restarting for them is routine
const BENIGN = new Set(['no-match', 'speech-timeout', 'session ended'])
const MAX_RESTARTS_PER_MINUTE = 6

/** One live recognition for a recording; restarts its native session when that ends early. */
export class SystemSpeech {
  private session = -1
  private running = false
  private stopping: (() => void) | null = null
  private restarts: number[] = []
  private lastOpenAt = 0
  private subs: Array<{ remove(): void }> = []

  constructor(private locale: string, private handlers: SystemSpeechHandlers) {}

  async start(): Promise<void> {
    const m = ForegroundService!
    this.running = true
    const mine = (e: { session: number }) => e.session === this.session
    this.subs.push(
      m.addListener('onSpeechPartial', (e) => mine(e) && this.handlers.onPartial(e.text)),
      m.addListener('onSpeechSegment', (e) => mine(e) && this.handlers.onSegment(e.text)),
      m.addListener('onSpeechError', (e) => mine(e) && this.onError(e.message)),
      m.addListener('onSpeechEnd', (e) => mine(e) && this.onEnd()),
    )
    await this.open()
    log('info', `on-device speech started (${this.locale})`)
  }

  feed(pcm: Int16Array): void {
    if (this.running) ForegroundService!.speechFeed(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  }

  /** Finish the last line, then release the recognizer. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    const ended = new Promise<void>((resolve) => (this.stopping = resolve))
    await ForegroundService!.speechStop().catch(() => undefined)
    await Promise.race([ended, new Promise((r) => setTimeout(r, 4000))])
    this.release()
  }

  /** Drop everything now (no more results). */
  cancel(): void {
    this.running = false
    this.release()
  }

  private release() {
    this.subs.forEach((s) => s.remove())
    this.subs = []
    this.stopping = null
    void ForegroundService!.speechCancel().catch(() => undefined)
  }

  private async open() {
    this.lastOpenAt = Date.now()
    this.session = await ForegroundService!.speechStart(this.locale)
  }

  private onEnd() {
    if (this.stopping) {
      this.stopping()
      return
    }
    // the service ended the session while we're still recording: start a new one
    if (this.running) void this.restart('session ended')
  }

  private onError(message: string) {
    log(message === 'no-match' ? 'info' : 'warn', `on-device speech: ${message}`)
    if (this.stopping) {
      this.stopping()
      return
    }
    if (!this.running) return
    if (FATAL.has(message)) {
      this.fatal(message)
      return
    }
    void this.restart(message)
  }

  private async restart(reason: string) {
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < 60_000)
    if (!BENIGN.has(reason)) this.restarts.push(now)
    if (this.restarts.length > MAX_RESTARTS_PER_MINUTE) {
      this.fatal(`keeps stopping (${reason})`)
      return
    }
    try {
      // never spin: a session that ends at once is retried at most once a second
      const wait = this.lastOpenAt + 1000 - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (!this.running) return
      await this.open()
    } catch (err) {
      this.fatal(String(err))
    }
  }

  private fatal(reason: string) {
    this.cancel()
    this.handlers.onFatal(reason)
  }
}
