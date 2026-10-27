// Mobile transcription session controller.
//
//   mic (expo-audio AudioStream) -> WAV on disk (the session timeline)
//                                -> engine, one of:
//                                   Android on-device speech (streams words and lines in real time), or
//                                   Slicer -> EngineQueue (whisper.rn: greedy previews, beam finals)
//                                -> romanizer -> SQLite segments -> UI
//
// Android speech is used when the phone has it with the language pack installed: it keeps
// up on any phone. Whisper is the fallback (iOS, older Android, no language pack, or the
// recognizer failing mid-call, in which case the session switches over seamlessly).
//
// Reliability: the WAV is written before transcription, so a crash loses no audio.
// On failure capture restarts with exponential backoff (silence is written for the
// gap to keep timestamps aligned); on next launch an interrupted session's
// untranscribed tail is transcribed from the WAV.

import { AppState, type AppStateStatus, Platform } from 'react-native'
import { File } from 'expo-file-system'
import { requestNotificationPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio'
import { LIVE_STATES, backoffDelay, canTransition, transition, type SessionEvent, type SessionState } from '../shared/session-state'
import { sessionTitle } from '../shared/transcript-format'
import { MOBILE_MODEL } from '../shared/models'
import { cleanTranscript } from '../shared/romanizer'
import type { Segment } from '../shared/types'
import * as db from './db'
import { log, updateDiagnostics } from './diagnostics'
import { decodeOptions, getContexts, resetContexts, transcribePcm } from './engine'
import { EngineQueue, type SliceJob } from './engine-queue'
import { newSessionDir, WavWriter, writeTranscriptFiles } from './files'
import { Mic } from './mic'
import { Slicer } from './slicer'
import { startForegroundService, stopForegroundService, updateForegroundService } from './background'
import { BYTES_PER_MS, gapFillBytes, tailWindows } from './wav'
import { NO_SPEECH, SystemSpeech, speechTrials, systemLocale, systemSpeechInfo, trialKey, type SpeechTrial } from './system-speech'

const SPEAKER = 'Speaker'
const STALL_MS = 8000
const MAX_ENGINE_ERRORS = 3
/** Android speech reports a line at the pause; it began roughly this long before its first words showed. */
const PARTIAL_LAG_MS = 1500

export interface RecorderState {
  status: SessionState
  sessionId: string | null
  startedAt: number | null
  segments: Segment[]
  /** live previews of slices still being spoken / finalized, keyed by slice start */
  previews: Record<number, string>
  message: string | null
  /** recovery of interrupted sessions in progress */
  recovering: boolean
}

interface Active {
  session: db.StoredSession
  wav: WavWriter
  mic: Mic | null
  slicer: Slicer | null
  /** WAV position (ms) where the current slicer's timeline starts */
  sliceOffsetMs: number
  queue: EngineQueue
  lastDataAt: number
  failedAt: number | null
  attempt: number
  engineErrors: number
  retryTimer: ReturnType<typeof setTimeout> | null
  stallTimer: ReturnType<typeof setInterval>
  writeTimer: ReturnType<typeof setTimeout> | null
  showPartials: boolean
  /** Android on-device speech, when it is the engine for this session */
  speech: SystemSpeech | null
  /** WAV time where the line Android speech is currently hearing began */
  speechLineStart: number | null
  /** WAV time where the last line ended */
  lastLineEnd: number
}

let seq = 0
const uuid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`

class Recorder {
  private state: RecorderState = {
    status: 'idle', sessionId: null, startedAt: null, segments: [], previews: {}, message: null, recovering: false,
  }
  private listeners = new Set<() => void>()
  private cur: Active | null = null
  private appStateSub: { remove(): void } | null = null
  /** crash recovery uses the speech model too; a new session waits for it to finish */
  private recovery: Promise<void> = Promise.resolve()

  // ---------------------------------------------------------------- store API

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getState = () => this.state

  private set(patch: Partial<RecorderState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  private fire(event: SessionEvent) {
    if (!canTransition(this.state.status, event)) return
    const status = transition(this.state.status, event)
    if (this.cur && status !== 'idle') db.updateSession(this.cur.session.id, { status: status as db.StoredSession['status'] })
    this.set({ status })
  }

  // ---------------------------------------------------------------- lifecycle

  async start(opts: { parentId?: string; title?: string } = {}): Promise<void> {
    if (this.cur || this.starting) return
    this.starting = true
    try {
      await this.recovery
      await this.begin(opts)
    } finally {
      this.starting = false
    }
  }

  private starting = false

  private async begin(opts: { parentId?: string; title?: string }): Promise<void> {
    if (this.state.status === 'saved' || this.state.status === 'interrupted') this.fire('RESET')

    const mic = await requestRecordingPermissionsAsync()
    if (!mic.granted) {
      this.set({ message: 'Microphone permission is needed to transcribe. Enable it in system settings.' })
      return
    }
    // permission dialogs can only appear while the app is on screen (not from the bubble)
    if (Platform.OS === 'android' && AppState.currentState === 'active') await requestNotificationPermissionsAsync().catch(() => undefined)

    const settings = db.getSettings()
    // remembered per phone: the recognizer that worked goes first; 'none' = none returned text
    const info = settings.engine === 'whisper' || settings.speechMode === NO_SPEECH ? null : await systemSpeechInfo(settings.language)
    const trials = info?.status === 'ready' ? speechTrials(info.modes, settings.speechMode) : []
    const useSystem = trials.length > 0
    const now = new Date()
    const sessionId = uuid()
    const dir = newSessionDir(sessionId, now)
    const wavFile = new File(dir, 'recording.wav')
    const session: db.StoredSession = {
      id: sessionId,
      title: opts.title ?? sessionTitle(now),
      startedAt: now.getTime(),
      endedAt: null,
      status: 'starting',
      language: settings.language,
      model: useSystem ? 'android-speech' : MOBILE_MODEL.id,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      dir: dir.uri,
      parentId: opts.parentId ?? null,
      audioPath: wavFile.uri,
      keepAudio: settings.keepAudio,
    }
    db.createSession(session)

    const cur: Active = {
      session,
      wav: new WavWriter(wavFile),
      mic: null,
      slicer: null,
      sliceOffsetMs: 0,
      queue: null as unknown as EngineQueue,
      lastDataAt: Date.now(),
      failedAt: null,
      attempt: 0,
      engineErrors: 0,
      retryTimer: null,
      stallTimer: setInterval(() => this.checkStall(), 2000),
      writeTimer: null,
      showPartials: settings.showPartials,
      speech: null,
      speechLineStart: null,
      lastLineEnd: 0,
    }
    cur.queue = new EngineQueue(
      { getContexts, decodeOptions: (kind, ms, behind) => decodeOptions(session.language, kind, ms, behind) },
      {
        onFinal: (job, text, raw, ms) => this.onFinal(cur, job, text, raw, ms),
        onPartial: (job, text, ms) => this.onPartial(cur, job, text, ms),
        onError: (err, kind) => this.onEngineError(cur, err, kind),
      },
    )
    this.cur = cur
    this.set({ sessionId, startedAt: session.startedAt, segments: [], previews: {}, message: null })
    this.fire('START')
    this.appStateSub = AppState.addEventListener('change', (s) => this.onAppState(s))
    const c = Platform.constants as unknown as Record<string, unknown>
    log('info', `session ${sessionId} starting (${settings.language}) on ${Platform.OS} ${c.Release ?? Platform.Version} ${[c.Brand, c.Model].filter(Boolean).join(' ')}`.trim())

    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true, interruptionMode: 'mixWithOthers' })
      await startForegroundService()
    } catch (err) {
      // not fatal: transcription still works while the app is in the foreground
      log('warn', `background mode unavailable: ${err}`)
    }
    if (useSystem) {
      try {
        await this.startSystemSpeech(cur, trials)
      } catch (err) {
        this.useWhisper(cur, `could not start: ${err}`)
      }
    } else {
      this.preloadWhisper(cur)
    }
    await this.startCapture(cur)
  }

  async stop(): Promise<void> {
    const cur = this.cur
    if (!cur || this.state.status === 'stopping') return
    this.fire('STOP')
    this.set({ message: 'Saving…' })
    clearInterval(cur.stallTimer)
    if (cur.retryTimer) clearTimeout(cur.retryTimer)
    await cur.mic?.stop()
    cur.mic = null
    await cur.speech?.stop()
    cur.speech = null
    this.flushSlicer(cur)
    // every line is transcribed before the session closes, however far behind a slow
    // phone is; the user sees the count go down (a crash here is recovered from the WAV)
    await this.drainWithProgress(cur)
    cur.queue.close()
    cur.wav.close()

    // the status must be written here: fire('STOPPED') below runs after this.cur is cleared,
    // and a session left in "stopping" is treated as a crash (and re-transcribed) on next launch
    db.updateSession(cur.session.id, { endedAt: Date.now(), status: 'saved' })
    this.cur = null
    this.appStateSub?.remove()
    this.appStateSub = null
    await stopForegroundService().catch(() => undefined)
    updateDiagnostics({ speaking: false, level: 0 })

    const saved = db.getSession(cur.session.id)
    if (saved) {
      writeTranscriptFiles(saved, db.segments(saved.id))
      if (!saved.keepAudio) {
        new File(cur.wav.file.uri).delete()
        db.updateSession(saved.id, { audioPath: null })
      }
    }
    log('info', `session ${cur.session.id} saved (${this.state.segments.length} lines)`)
    this.fire('STOPPED')
    this.set({ message: null, previews: {} })
    this.fire('RESET')
    this.set({ sessionId: null, startedAt: null })
  }

  async resume(sessionId: string): Promise<void> {
    const prev = db.getSession(sessionId)
    if (!prev || this.cur) return
    await this.start({ parentId: prev.id, title: `${prev.title.replace(/ \(continued\)$/, '')} (continued)` })
  }

  // ---------------------------------------------------------------- capture → slicer → queue

  private async startCapture(cur: Active): Promise<void> {
    try {
      // fill any capture gap with silence so WAV time == wall-clock session time
      if (cur.failedAt) {
        const gap = gapFillBytes(Date.now() - cur.lastDataAt)
        if (gap > 0) cur.wav.append(new Uint8Array(gap))
      }
      if (!cur.speech) {
        cur.slicer = new Slicer()
        cur.sliceOffsetMs = cur.wav.durationMs
      }
      const mic = new Mic((pcm) => this.onPcm(cur, pcm))
      cur.mic = mic
      cur.lastDataAt = Date.now()
      await mic.start()
    } catch (err) {
      this.onFailure(cur, `microphone could not start: ${err instanceof Error ? err.message : err}`)
    }
  }

  private onPcm(cur: Active, pcm: Int16Array) {
    if (this.cur !== cur || (!cur.slicer && !cur.speech)) return
    cur.wav.append(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    cur.lastDataAt = Date.now()
    if (this.state.status === 'starting' || this.state.status === 'retrying') this.onRecovered(cur)
    if (cur.speech) {
      // feeding can end the last trial and switch this call to whisper right here
      cur.speech.feed(pcm)
      return
    }
    this.slice(cur, pcm, true)
  }

  /** Slicer -> whisper queue. `live` = just recorded (not replayed), so previews make sense. */
  private slice(cur: Active, pcm: Int16Array, live: boolean) {
    if (!cur.slicer) return
    for (const ev of cur.slicer.push(pcm)) {
      const job: SliceJob = { startMs: cur.sliceOffsetMs + ev.startMs, endMs: cur.sliceOffsetMs + ev.endMs, pcm: ev.audio }
      if (ev.type === 'final') cur.queue.pushFinal(job)
      else if (live && cur.showPartials) cur.queue.offerPartial(job)
    }
    if (cur.slicer.speaking !== this.lastSpeaking) {
      this.lastSpeaking = cur.slicer.speaking
      updateDiagnostics({ speaking: cur.slicer.speaking, finalsQueued: cur.queue.pending })
    }
  }

  private lastSpeaking = false

  private flushSlicer(cur: Active) {
    for (const ev of cur.slicer?.flush() ?? []) {
      cur.queue.pushFinal({ startMs: cur.sliceOffsetMs + ev.startMs, endMs: cur.sliceOffsetMs + ev.endMs, pcm: ev.audio })
    }
    cur.slicer = null
  }

  private partialCount = 0

  // ---------------------------------------------------------------- Android on-device speech

  private async startSystemSpeech(cur: Active, trials: SpeechTrial[]): Promise<void> {
    const speech = new SystemSpeech(systemLocale(cur.session.language), trials, {
      onPartial: (text) => this.onSystemPartial(cur, text),
      onSegment: (text) => this.onSystemSegment(cur, text),
      onFatal: (reason, untranscribed) => {
        // nothing on this phone answered: start calls on whisper from now on (Settings can retry)
        if (reason.startsWith('no recognizer')) db.setSettings({ speechMode: NO_SPEECH })
        this.useWhisper(cur, reason, untranscribed)
      },
      onWorking: (trial) => {
        if (db.getSettings().speechMode !== trialKey(trial)) db.setSettings({ speechMode: trialKey(trial) })
      },
    })
    cur.speech = speech
    await speech.start()
  }

  private onSystemPartial(cur: Active, raw: string) {
    if (this.cur !== cur) return
    const now = cur.wav.durationMs
    cur.speechLineStart ??= Math.max(cur.lastLineEnd, now - PARTIAL_LAG_MS)
    if (!cur.showPartials) return
    const text = cleanTranscript(raw)
    if (text) this.set({ previews: { [cur.speechLineStart]: text } })
  }

  private onSystemSegment(cur: Active, raw: string) {
    const endMs = cur.wav.durationMs
    const startMs = cur.speechLineStart ?? Math.max(cur.lastLineEnd, endMs - PARTIAL_LAG_MS)
    cur.speechLineStart = null
    cur.lastLineEnd = endMs
    const text = cleanTranscript(raw)
    log('info', `line: ${endMs - startMs} ms audio (android speech)${text ? '' : ' (no speech)'}`)
    if (this.cur === cur) this.set({ previews: {} })
    if (text) this.addLine(cur, { startMs, endMs, text, raw })
  }

  /** Switch this session to whisper (Android speech unavailable or failing). */
  private useWhisper(cur: Active, reason: string, untranscribed: Int16Array[] = []) {
    log('warn', `android speech: ${reason}; using the built-in model`)
    cur.speech?.cancel()
    cur.speech = null
    cur.speechLineStart = null
    // a session that switched mid-call records both engines
    if (cur.session.model !== MOBILE_MODEL.id) {
      cur.session.model = cur.wav.durationMs > 0 ? `${cur.session.model}+${MOBILE_MODEL.id}` : MOBILE_MODEL.id
      db.updateSession(cur.session.id, { model: cur.session.model })
    }
    this.preloadWhisper(cur)
    if (this.cur === cur) {
      // whisper starts from where Android speech's last line ended, so no words are lost
      cur.slicer = new Slicer()
      cur.sliceOffsetMs = cur.wav.durationMs - untranscribed.reduce((n, p) => n + p.length / 16, 0)
      for (const pcm of untranscribed) this.slice(cur, pcm, false)
      this.set({ previews: {}, message: 'Android speech gave no text on this phone, so Call Notes switched to its built-in model. Nothing was lost.' })
    }
  }

  /** Load whisper while the mic starts, so the first slice doesn't wait for it. */
  private preloadWhisper(cur: Active) {
    void getContexts().catch((err) => {
      log('error', `model load failed: ${err}`)
      if (this.cur === cur) this.set({ message: 'The speech model could not load. Close and reopen Call Notes; your audio is still being saved.' })
    })
  }

  private async drainWithProgress(cur: Active): Promise<void> {
    const tick = setInterval(() => {
      const n = cur.queue.pending
      if (n > 0) this.set({ message: `Finishing ${n} line${n === 1 ? '' : 's'}…` })
    }, 500)
    try {
      await cur.queue.drain()
    } finally {
      clearInterval(tick)
    }
  }

  private onPartial(cur: Active, job: SliceJob, text: string, latencyMs: number) {
    if (this.cur !== cur) return
    updateDiagnostics({ lastPartialMs: latencyMs })
    if (this.partialCount++ % 10 === 0) log('info', `preview: ${Math.round(job.pcm.length / 16)} ms audio, ready after ${latencyMs} ms`)
    if (text) this.set({ previews: { ...this.state.previews, [job.startMs]: text } })
  }

  private onFinal(cur: Active, job: SliceJob, text: string, raw: string, latencyMs: number) {
    log('info', `line: ${job.endMs - job.startMs} ms audio, ready ${latencyMs} ms after the pause${text ? '' : ' (no speech)'}`)
    if (cur.engineErrors > 0 && this.cur === cur && this.state.status === 'recording') this.set({ message: null })
    cur.engineErrors = 0
    updateDiagnostics({ lastFinalMs: latencyMs, finalsQueued: cur.queue.pending })
    // the preview stays on screen until its final replaces it, so text never blinks out
    if (this.cur === cur) {
      const previews = { ...this.state.previews }
      for (const start of job.parts ?? [job.startMs]) delete previews[start]
      this.set({ previews })
    }
    if (text) this.addLine(cur, { startMs: job.startMs, endMs: job.endMs, text, raw })
  }

  private addLine(cur: Active, line: { startMs: number; endMs: number; text: string; raw: string }) {
    const seg: Segment = {
      id: `${cur.session.id}-${line.startMs}`,
      sessionId: cur.session.id,
      stream: 'mic',
      speaker: SPEAKER,
      startMs: line.startMs,
      endMs: line.endMs,
      text: line.text,
      rawText: line.raw,
    }
    db.addSegment(seg)
    if (this.cur === cur || this.state.sessionId === cur.session.id) this.set({ segments: [...this.state.segments, seg] })
    void updateForegroundService(line.text.slice(0, 80)).catch(() => undefined)
    this.scheduleWrite(cur)
  }

  private scheduleWrite(cur: Active) {
    if (cur.writeTimer) clearTimeout(cur.writeTimer)
    cur.writeTimer = setTimeout(() => {
      const s = db.getSession(cur.session.id)
      if (s) writeTranscriptFiles(s, db.segments(s.id))
    }, 2000)
  }

  // ---------------------------------------------------------------- failures & retries

  private onEngineError(cur: Active, err: unknown, kind: 'final' | 'partial') {
    log('error', `${kind} transcription failed: ${err}`)
    if (this.cur !== cur) return
    // tolerate a few errors, then reload the model; tell the user either way
    if (++cur.engineErrors >= MAX_ENGINE_ERRORS) {
      cur.engineErrors = 0
      this.set({ message: 'Transcription stopped working, reloading the speech model. Your audio is still being saved.' })
      void resetContexts().then(() => log('warn', 'speech model reloaded after repeated errors'))
    } else if (kind === 'final') {
      this.set({ message: 'A line could not be transcribed. Trying again with the next one.' })
    }
  }

  private checkStall() {
    const cur = this.cur
    if (!cur || this.state.status !== 'recording') return
    if (Date.now() - cur.lastDataAt > STALL_MS) this.onFailure(cur, 'microphone stopped delivering audio')
  }

  private onFailure(cur: Active, reason: string) {
    if (this.cur !== cur || this.state.status === 'stopping' || cur.retryTimer) return
    log('warn', reason)
    cur.failedAt ??= Date.now()
    void cur.mic?.stop()
    cur.mic = null
    this.flushSlicer(cur)
    this.fire('FAILURE')
    const delay = backoffDelay(cur.attempt++)
    this.set({ message: `${reason} — retrying in ${Math.round(delay / 1000)} s` })
    cur.retryTimer = setTimeout(() => {
      cur.retryTimer = null
      if (this.cur === cur) void this.startCapture(cur)
    }, delay)
  }

  private onRecovered(cur: Active) {
    if (this.state.status === 'retrying' && cur.failedAt && Date.now() - cur.failedAt > 2000) {
      const gapMs = Date.now() - cur.failedAt
      const now = cur.wav.durationMs
      const seg: Segment = {
        id: uuid(), sessionId: cur.session.id, stream: 'mic', speaker: 'Notice',
        startMs: Math.max(0, now - gapMs), endMs: now,
        text: `[Microphone was unavailable for ${Math.round(gapMs / 1000)} s]`,
      }
      db.addSegment(seg)
      this.set({ segments: [...this.state.segments, seg] })
    }
    cur.failedAt = null
    cur.attempt = 0
    this.fire(this.state.status === 'starting' ? 'STARTED' : 'RECOVERED')
    this.set({ message: null })
  }

  private onAppState(s: AppStateStatus) {
    const cur = this.cur
    // back in the foreground while retrying (e.g. after a phone call): retry now
    if (s === 'active' && cur && this.state.status === 'retrying' && cur.retryTimer) {
      clearTimeout(cur.retryTimer)
      cur.retryTimer = null
      void this.startCapture(cur)
    }
  }

  // ---------------------------------------------------------------- crash recovery

  /** Close sessions a crash left open and transcribe the audio after their last segment. */
  recover(): Promise<void> {
    this.recovery = this.runRecovery()
    return this.recovery
  }

  private async runRecovery(): Promise<void> {
    const crashed = db.sessionsWithStatus(LIVE_STATES)
    if (crashed.length === 0) return
    this.set({ recovering: true })
    for (const s of crashed) {
      const lastEnd = db.lastSegmentEnd(s.id) ?? 0
      let endMs = lastEnd
      try {
        const file = s.audioPath ? new File(s.audioPath) : null
        if (file?.exists) {
          WavWriter.repairHeader(file)
          for (const w of tailWindows(file.size ?? 0, lastEnd)) {
            const pcm = WavWriter.readRange(file, w.offset, w.length)
            const { text, raw } = await transcribePcm(pcm.buffer as ArrayBuffer, s.language)
            endMs = w.startMs + w.length / BYTES_PER_MS
            // the user may delete the call from history while it is being recovered
            if (!db.getSession(s.id)) break
            if (text) {
              db.addSegment({
                id: `${s.id}-recovered-${w.startMs}`, sessionId: s.id, stream: 'mic', speaker: SPEAKER,
                startMs: w.startMs, endMs, text, rawText: raw,
              })
            }
          }
          if (!s.keepAudio) {
            file.delete()
            db.updateSession(s.id, { audioPath: null })
          }
        }
      } catch (err) {
        log('error', `recovery of ${s.id} failed: ${err}`)
      }
      db.updateSession(s.id, { status: 'interrupted', endedAt: s.startedAt + endMs })
      const updated = db.getSession(s.id)
      if (updated) writeTranscriptFiles(updated, db.segments(s.id))
      log('info', `recovered interrupted session ${s.id}`)
    }
    this.set({ recovering: false })
  }
}

export const recorder = new Recorder()
