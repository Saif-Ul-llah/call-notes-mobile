// Android's on-device speech recognizer (the offline engine behind Google voice typing)
// as the live engine. Our microphone PCM is streamed into it, so the WAV recording stays
// ours; it returns words while people talk and a line at every pause, in real time even
// on low-end phones where whisper can't keep up. Android 13+, language pack required.
//
// Hindi comes back in Devanagari; the romanizer turns it into Roman Urdu/Hindi.
//
// Not every phone's recognizer accepts audio from an app: some start, then stay silent
// (seen on a Redmi with Android 16). So each recognizer gets a trial: if ~10 s of speech
// go in and nothing at all comes back, the next one is tried, and if none works the call
// switches to whisper. What worked (or that nothing did) is remembered per phone.

import { Platform } from 'react-native'
import ForegroundService from '../../modules/call-notes-foreground'
import type { SpeechMode, SpeechSupport } from '../../modules/call-notes-foreground/src/CallNotesForegroundServiceModule'
import type { LanguageMode } from '../shared/types'
import { log } from './diagnostics'

export type SystemSpeechStatus = 'ready' | 'downloading' | 'needs-download' | 'unsupported'

export const systemSpeechSupported = Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 33 && !!ForegroundService

/** Hindi covers spoken Urdu and Hinglish; Roman output comes from the romanizer. */
export function systemLocale(mode: LanguageMode): string {
  return mode === 'en' ? 'en-IN' : 'hi-IN'
}

const sameLocale = (a: string, b: string) => a.replace('_', '-').toLowerCase() === b.toLowerCase()

export type { SpeechMode }

export interface SystemSpeechInfo {
  status: SystemSpeechStatus
  /** recognizers to try, best first */
  modes: SpeechMode[]
}

export async function systemSpeechStatus(mode: LanguageMode): Promise<SystemSpeechStatus> {
  return (await systemSpeechInfo(mode)).status
}

export async function systemSpeechInfo(mode: LanguageMode): Promise<SystemSpeechInfo> {
  const none: SystemSpeechInfo = { status: 'unsupported', modes: [] }
  if (!systemSpeechSupported) return none
  const locale = systemLocale(mode)
  try {
    const s = await ForegroundService!.speechSupport(locale)
    if (!s.onDevice) return none
    const status = statusOf(s, locale)
    const modes: SpeechMode[] = s.kind === 'on-device' ? ['on-device', ...(s.hasDefault ? (['default'] as const) : [])] : ['default']
    // logged once per state change, so the shared log says why an engine was chosen
    const line = `android speech (${s.kind ?? '?'}) for ${locale}: ${status}; installed ${s.installed?.join(',') || 'none'}${s.error !== undefined ? `, check error ${s.error}` : ''}`
    if (line !== lastStatusLine) log('info', (lastStatusLine = line))
    return { status, modes }
  } catch (err) {
    log('warn', `on-device speech check failed: ${err}`)
    return none
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

/** One way to run a recognizer; remembered per phone as e.g. "on-device:sentence". */
export interface SpeechTrial {
  mode: SpeechMode
  /** one session per call (true) or one per sentence, voice-typing style (false) */
  segmented: boolean
}

export const trialKey = (t: SpeechTrial) => `${t.mode}:${t.segmented ? 'call' : 'sentence'}`

/**
 * Remembered when no way worked. Versioned: a new app version with new ways to try
 * starts fresh instead of trusting an old "nothing works" (0.4.1 stored plain "none").
 */
export const NO_SPEECH = 'none:2'

/** Every way to try the recognizers, best first; the one that worked before leads. */
export function speechTrials(modes: SpeechMode[], remembered?: string | null): SpeechTrial[] {
  const all = modes.flatMap((mode) => [{ mode, segmented: true }, { mode, segmented: false }])
  return all.sort((a, b) => Number(trialKey(b) === remembered) - Number(trialKey(a) === remembered))
}

export interface SystemSpeechHandlers {
  /** words of the line being spoken (replaces the previous partial) */
  onPartial(text: string): void
  /** a finished line (may be empty) */
  onSegment(text: string): void
  /** no recognizer works: switch to whisper, starting with `untranscribed` (audio since the last line) */
  onFatal(reason: string, untranscribed: Int16Array[]): void
  /** a recognizer returned text: worth trying first next time */
  onWorking(trial: SpeechTrial): void
}

// errors that mean this recognizer can't work here (try the next one)
const UNUSABLE = new Set(['language-not-supported', 'language-not-downloaded', 'permissions'])
// a quiet room ends sessions with these; restarting for them is routine
const BENIGN = new Set(['no-match', 'speech-timeout', 'session ended'])
const MAX_RESTARTS_PER_MINUTE = 6
/** A recognizer that returns nothing for this much speech fed to it is considered not working. */
const TRIAL_SPEECH_MS = 10000
/** Audio louder than this RMS (int16, about -40 dBFS) counts as speech for the trial. */
const SPEECH_RMS = 330
/** Audio kept for a retry or for whisper in case the recognizer fails before returning its line. */
const MAX_UNTRANSCRIBED_MS = 3 * 60 * 1000

/** One live recognition for a recording; restarts its native session when that ends. */
export class SystemSpeech {
  private session = -1
  private running = false
  private stopping: (() => void) | null = null
  private restarts: number[] = []
  private lastOpenAt = 0
  private subs: Array<{ remove(): void }> = []
  private index = 0
  /** the current recognizer has returned text or a line */
  private answered = false
  private speechFedMs = 0
  private feedError = false
  private debugSeen = new Set<string>()
  // audio since the last line: replayed into the next trial, or handed to whisper
  private untranscribed: Int16Array[] = []
  private untranscribedMs = 0

  constructor(private locale: string, private trials: SpeechTrial[], private handlers: SystemSpeechHandlers) {}

  get trial(): SpeechTrial {
    return this.trials[this.index]
  }

  private get name() {
    return trialKey(this.trial)
  }

  async start(): Promise<void> {
    const m = ForegroundService!
    this.running = true
    const mine = (e: { session: number }) => e.session === this.session
    this.subs.push(
      m.addListener('onSpeechPartial', (e) => mine(e) && this.onText(e.text, false)),
      m.addListener('onSpeechSegment', (e) => mine(e) && this.onText(e.text, true)),
      m.addListener('onSpeechError', (e) => mine(e) && this.onError(e.message)),
      m.addListener('onSpeechEnd', (e) => mine(e) && this.onEnd()),
      m.addListener('onSpeechReady', (e) => mine(e) && this.debug('ready')),
      m.addListener('onSpeechDebug', (e) => mine(e) && this.debug(e.message)),
    )
    await this.open(false)
  }

  feed(pcm: Int16Array): void {
    if (!this.running) return
    this.untranscribed.push(pcm)
    this.untranscribedMs += pcm.length / 16
    while (this.untranscribedMs > MAX_UNTRANSCRIBED_MS && this.untranscribed.length > 1) {
      this.untranscribedMs -= this.untranscribed.shift()!.length / 16
    }
    this.send(pcm)
    if (this.answered) return
    let sum = 0
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
    if (Math.sqrt(sum / Math.max(1, pcm.length)) > SPEECH_RMS) this.speechFedMs += pcm.length / 16
    if (this.speechFedMs >= TRIAL_SPEECH_MS) this.nextTrial('returned nothing')
  }

  private send(pcm: Int16Array) {
    try {
      ForegroundService!.speechFeed(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    } catch (err) {
      if (!this.feedError) log('error', `android speech: feeding audio failed: ${err}`)
      this.feedError = true
    }
  }

  private onText(text: string, final: boolean) {
    if (!this.answered && (text || final)) {
      this.answered = true
      log('info', `android speech (${this.name}) is returning text`)
      this.handlers.onWorking(this.trial)
    }
    if (final) {
      this.untranscribed = []
      this.untranscribedMs = 0
      this.handlers.onSegment(text)
    } else this.handlers.onPartial(text)
  }

  /** Recognizer progress, logged once per kind so a silent recognizer shows how far it got. */
  private debug(message: string) {
    const kind = message.replace(/\(.*\)/, '').trim()
    if (this.debugSeen.has(kind)) return
    this.debugSeen.add(kind)
    log('info', `android speech (${this.name}): ${message}`)
  }

  /** The current way didn't work: try the next one with the audio said so far, else give up. */
  private nextTrial(why: string) {
    const bytes = ForegroundService!.speechBytesWritten()
    log('warn', `android speech (${this.name}) ${why} after ${Math.round(this.speechFedMs / 1000)} s of speech ` +
      `(${Math.round(bytes / 32000)} s of audio taken, progress: ${[...this.debugSeen].join(', ') || 'none'})`)
    this.speechFedMs = 0
    this.debugSeen.clear()
    if (this.index + 1 >= this.trials.length) {
      this.fatal('no recognizer on this phone returned text')
      return
    }
    this.index++
    void this.open(false).then(
      () => this.untranscribed.forEach((pcm) => this.send(pcm)),
      (err) => this.fatal(String(err)),
    )
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

  /** `resume`: a sentence-per-session restart, which begins with the audio since the last sentence. */
  private async open(resume: boolean) {
    this.lastOpenAt = Date.now()
    const { mode, segmented } = this.trial
    this.session = await ForegroundService!.speechStart(this.locale, mode, segmented, resume)
    if (!resume) log('info', `android speech (${this.name}) started for ${this.locale}`)
  }

  private onEnd() {
    if (this.stopping) {
      this.stopping()
      return
    }
    // a sentence-per-session recognizer ends after every sentence; a segmented one may end early
    if (this.running) void this.restart('session ended')
  }

  private onError(message: string) {
    log(BENIGN.has(message) ? 'info' : 'warn', `android speech (${this.name}): ${message}`)
    if (this.stopping) {
      this.stopping()
      return
    }
    if (!this.running) return
    if (UNUSABLE.has(message)) {
      this.nextTrial(message)
      return
    }
    void this.restart(message)
  }

  private async restart(reason: string) {
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < 60_000)
    if (!BENIGN.has(reason)) this.restarts.push(now)
    if (this.restarts.length > MAX_RESTARTS_PER_MINUTE) {
      this.nextTrial(`keeps failing (${reason})`)
      return
    }
    try {
      // never spin: a session that ends at once is retried after a short pause (no audio is
      // lost meanwhile: a sentence-per-session restart replays what it missed)
      const wait = this.lastOpenAt + (this.trial.segmented ? 1000 : 300) - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (!this.running) return
      await this.open(!this.trial.segmented)
    } catch (err) {
      this.fatal(String(err))
    }
  }

  private fatal(reason: string) {
    const pending = this.untranscribed
    this.untranscribed = []
    this.untranscribedMs = 0
    this.cancel()
    this.handlers.onFatal(reason, pending)
  }
}
