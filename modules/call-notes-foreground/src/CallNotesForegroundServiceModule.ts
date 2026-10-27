import { NativeModule, requireOptionalNativeModule } from 'expo'

type SpeechEvent = { session: number }

type Events = {
  onBubblePress(): void
  onSpeechReady(e: SpeechEvent): void
  onSpeechPartial(e: SpeechEvent & { text: string }): void
  onSpeechSegment(e: SpeechEvent & { text: string }): void
  onSpeechEnd(e: SpeechEvent): void
  onSpeechError(e: SpeechEvent & { code: number; message: string }): void
  /** recognizer progress (ready, hearing audio, speech start/end) for the diagnostic log */
  onSpeechDebug(e: SpeechEvent & { message: string }): void
}

/** "on-device": the dedicated offline recognizer; "default": the default recognition service, offline preferred */
export type SpeechMode = 'on-device' | 'default'

export interface SpeechSupport {
  /** the phone has a speech recognizer at all */
  onDevice: boolean
  /** "on-device": the dedicated offline recognizer; "default": the default service in offline mode */
  kind?: 'on-device' | 'default'
  /** a default recognition service exists too (a second recognizer to try) */
  hasDefault?: boolean
  installed?: string[]
  pending?: string[]
  supported?: string[]
  error?: number
}

declare class CallNotesForegroundServiceModule extends NativeModule<Events> {
  start(title: string, text: string): void
  update(title: string, text: string): void
  stop(): void
  canDrawOverlays(): boolean
  openOverlaySettings(): void
  showBubble(): Promise<boolean>
  hideBubble(): Promise<void>
  setBubbleRecording(recording: boolean): Promise<void>
  deviceInfo(): { cores: number; memoryMb: number }
  /** Android 13+: which offline speech languages exist / are installed */
  speechSupport(locale: string): Promise<SpeechSupport>
  speechDownload(locale: string): Promise<void>
  /**
   * Starts a recognition session fed by speechFeed(); returns the session id. `segmented`: one
   * session for the whole call; otherwise one sentence per session. `resume`: begin with the
   * audio fed since the last sentence ended (restarting a sentence-per-session recognizer).
   */
  speechStart(locale: string, mode: SpeechMode, segmented: boolean, resume: boolean): Promise<number>
  /** bytes of audio the recognizer has taken this session */
  speechBytesWritten(): number
  /** 16 kHz mono PCM16 bytes */
  speechFeed(pcm: Uint8Array): void
  /** end of audio: the last segment is finished, then onSpeechEnd */
  speechStop(): Promise<void>
  speechCancel(): Promise<void>
}

// Android only: iOS keeps recording alive with the "audio" background mode and does not
// allow apps to draw over other apps.
export default requireOptionalNativeModule<CallNotesForegroundServiceModule>('CallNotesForegroundService')
