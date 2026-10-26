// Mobile transcription session controller.
//
//   mic (expo-audio AudioStream) -> WAV on disk (the session timeline)
//                                -> Slicer (speech slices, partial snapshots ~1 s)
//                                -> EngineQueue (whisper.rn: greedy previews, beam finals)
//                                -> romanizer -> SQLite segments -> UI
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

const SPEAKER = 'Speaker'
const STALL_MS = 8000
const MAX_ENGINE_ERRORS = 3

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
      model: MOBILE_MODEL.id,
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
    }
    cur.queue = new EngineQueue(
      { getContexts, decodeOptions: (kind, ms) => decodeOptions(session.language, kind, ms) },
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
    // load the model while the mic starts, so the first slice doesn't wait for it
    void getContexts().catch((err) => {
      log('error', `model load failed: ${err}`)
      if (this.cur === cur) this.set({ message: 'The speech model could not load. Close and reopen Call Notes; your audio is still being saved.' })
    })
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
    this.flushSlicer(cur)
    // let queued slices finish (bounded: the audio is safe on disk anyway)
    await Promise.race([cur.queue.drain(), new Promise((r) => setTimeout(r, 20000))])
    cur.queue.close()
    cur.wav.close()

    db.updateSession(cur.session.id, { endedAt: Date.now() })
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
      cur.slicer = new Slicer()
      cur.sliceOffsetMs = cur.wav.durationMs
      const mic = new Mic((pcm) => this.onPcm(cur, pcm))
      cur.mic = mic
      cur.lastDataAt = Date.now()
      await mic.start()
    } catch (err) {
      this.onFailure(cur, `microphone could not start: ${err instanceof Error ? err.message : err}`)
    }
  }

  private onPcm(cur: Active, pcm: Int16Array) {
    if (this.cur !== cur || !cur.slicer) return
    cur.wav.append(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    cur.lastDataAt = Date.now()
    if (this.state.status === 'starting' || this.state.status === 'retrying') this.onRecovered(cur)

    for (const ev of cur.slicer.push(pcm)) {
      const job: SliceJob = { startMs: cur.sliceOffsetMs + ev.startMs, endMs: cur.sliceOffsetMs + ev.endMs, pcm: ev.audio }
      if (ev.type === 'final') cur.queue.pushFinal(job)
      else if (cur.showPartials) cur.queue.offerPartial(job)
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
    const live = this.cur === cur
    // the preview stays on screen until its final replaces it, so text never blinks out
    const { [job.startMs]: _done, ...previews } = this.state.previews
    if (live) this.set({ previews })
    if (!text) return
    const seg: Segment = {
      id: `${cur.session.id}-${job.startMs}`,
      sessionId: cur.session.id,
      stream: 'mic',
      speaker: SPEAKER,
      startMs: job.startMs,
      endMs: job.endMs,
      text,
      rawText: raw,
    }
    db.addSegment(seg)
    if (live || this.state.sessionId === cur.session.id) this.set({ segments: [...this.state.segments, seg] })
    void updateForegroundService(text.slice(0, 80)).catch(() => undefined)
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
