// Mobile transcription session controller.
//
//   mic (expo-audio AudioStream) --tap--> WAV on disk (the session timeline)
//                                 \-----> whisper.rn RealtimeTranscriber (Silero VAD slices)
//                                          -> romanizer -> SQLite segments -> UI
//
// Reliability: the WAV is written before transcription, so a crash loses no audio.
// On failure the capture/transcriber restarts with exponential backoff (silence is
// written for the gap to keep timestamps aligned); on next launch an interrupted
// session's untranscribed tail is transcribed from the WAV.

import { AppState, type AppStateStatus, Platform } from 'react-native'
import { File } from 'expo-file-system'
import { requestNotificationPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio'
import { RealtimeTranscriber, RingBufferVad } from 'whisper.rn/src/realtime-transcription'
import type { RealtimeTranscribeEvent } from 'whisper.rn/src/realtime-transcription/types'
import { cleanTranscript } from '../shared/romanizer'
import { LIVE_STATES, backoffDelay, canTransition, transition, type SessionEvent, type SessionState } from '../shared/session-state'
import { sessionTitle } from '../shared/transcript-format'
import { MOBILE_MODEL } from '../shared/models'
import type { Segment } from '../shared/types'
import * as db from './db'
import { getContexts, resetContexts, transcribeOptions, transcribePcm } from './engine'
import { ExpoAudioStream } from './expo-audio-stream'
import { newSessionDir, WavWriter, writeTranscriptFiles } from './files'
import { startForegroundService, stopForegroundService, updateForegroundService } from './background'
import { BYTES_PER_MS, gapFillBytes, tailWindows } from './wav'

const SPEAKER = 'Speaker'
const STALL_MS = 8000
const MAX_TRANSCRIBE_ERRORS = 3

export interface RecorderState {
  status: SessionState
  sessionId: string | null
  startedAt: number | null
  segments: Segment[]
  partial: string | null
  message: string | null
  /** recovery of interrupted sessions in progress */
  recovering: boolean
}

interface SliceTrack {
  startMs: number
  text: string
  raw: string
  durationMs: number
  finalized: boolean
}

interface Active {
  session: db.StoredSession
  wav: WavWriter
  transcriber: RealtimeTranscriber | null
  /** increments on every transcriber restart; slice indexes restart from 0 each run */
  run: number
  slices: Map<number, SliceTrack>
  lastDataAt: number
  failedAt: number | null
  attempt: number
  transcribeErrors: number
  retryTimer: ReturnType<typeof setTimeout> | null
  stallTimer: ReturnType<typeof setInterval>
  writeTimer: ReturnType<typeof setTimeout> | null
  showPartials: boolean
}

let id = 0
const uuid = () => `${Date.now().toString(36)}-${(id++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`

class Recorder {
  private state: RecorderState = {
    status: 'idle', sessionId: null, startedAt: null, segments: [], partial: null, message: null, recovering: false,
  }
  private listeners = new Set<() => void>()
  private cur: Active | null = null
  private appStateSub: { remove(): void } | null = null

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
    if (this.cur) return
    if (this.state.status === 'saved' || this.state.status === 'interrupted') this.fire('RESET')

    const mic = await requestRecordingPermissionsAsync()
    if (!mic.granted) {
      this.set({ message: 'Microphone permission is needed to transcribe. Enable it in system settings.' })
      return
    }
    if (Platform.OS === 'android') await requestNotificationPermissionsAsync().catch(() => undefined)

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

    this.cur = {
      session,
      wav: new WavWriter(wavFile),
      transcriber: null,
      run: 0,
      slices: new Map(),
      lastDataAt: Date.now(),
      failedAt: null,
      attempt: 0,
      transcribeErrors: 0,
      retryTimer: null,
      stallTimer: setInterval(() => this.checkStall(), 2000),
      writeTimer: null,
      showPartials: settings.showPartials,
    }
    this.set({ sessionId, startedAt: session.startedAt, segments: [], partial: null, message: null })
    this.fire('START')
    this.appStateSub = AppState.addEventListener('change', (s) => this.onAppState(s))

    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true, interruptionMode: 'mixWithOthers' })
      await startForegroundService()
    } catch (err) {
      // not fatal: transcription still works while the app is in the foreground
      this.set({ message: `Background mode unavailable: ${err}` })
    }
    await this.runTranscriber()
  }

  async stop(): Promise<void> {
    const cur = this.cur
    if (!cur || this.state.status === 'stopping') return
    this.fire('STOP')
    this.set({ message: 'Saving…' })
    clearInterval(cur.stallTimer)
    if (cur.retryTimer) clearTimeout(cur.retryTimer)
    // let the transcriber finish its queue (bounded: the audio is safe on disk anyway)
    await Promise.race([this.teardownTranscriber(cur), new Promise((r) => setTimeout(r, 20000))])
    this.finalizeAllSlices(cur)
    cur.wav.close()

    const endedAt = Date.now()
    db.updateSession(cur.session.id, { endedAt })
    this.cur = null
    this.appStateSub?.remove()
    this.appStateSub = null
    await stopForegroundService().catch(() => undefined)

    const saved = db.getSession(cur.session.id)
    if (saved) {
      writeTranscriptFiles(saved, db.segments(saved.id))
      if (!saved.keepAudio) {
        new File(cur.wav.file.uri).delete()
        db.updateSession(saved.id, { audioPath: null })
      }
    }
    this.fire('STOPPED')
    this.set({ message: null, partial: null })
    this.fire('RESET')
    this.set({ sessionId: null, startedAt: null })
  }

  async resume(sessionId: string): Promise<void> {
    const prev = db.getSession(sessionId)
    if (!prev || this.cur) return
    await this.start({ parentId: prev.id, title: `${prev.title.replace(/ \(continued\)$/, '')} (continued)` })
  }

  // ---------------------------------------------------------------- transcriber

  private onPcm(cur: Active, pcm: Uint8Array) {
    cur.wav.append(pcm)
    cur.lastDataAt = Date.now()
    if (this.state.status === 'starting' || this.state.status === 'retrying') this.onRecovered(cur)
  }

  private async runTranscriber(): Promise<void> {
    const cur = this.cur
    if (!cur) return
    try {
      const { whisper, vad } = await getContexts()
      if (this.cur !== cur) return
      cur.run++
      cur.slices.clear()
      // fill any capture gap with silence so WAV time == wall-clock session time
      const gap = cur.failedAt ? gapFillBytes(Date.now() - cur.lastDataAt) : 0
      if (gap > 0) cur.wav.append(new Uint8Array(gap))

      const stream = new ExpoAudioStream((pcm) => this.onPcm(cur, pcm))
      const run = cur.run
      const transcriber = new RealtimeTranscriber(
        { whisperContext: whisper, vadContext: new RingBufferVad(vad, { vadPreset: 'meeting', preRecordingBufferMs: 600 }), audioStream: stream },
        {
          audioSliceSec: 25,
          audioMinSec: 1,
          maxSlicesInMemory: 3,
          transcribeOptions: transcribeOptions(cur.session.language),
          promptPreviousSlices: false, // the Hinglish model drifts to English spellings with prompts
          realtimeProcessingPauseMs: 1500, // partial previews at most every 1.5 s to spare the CPU
          initRealtimeAfterMs: 1200,
        },
        {
          onTranscribe: (ev) => this.onTranscribe(cur, run, ev),
          onSliceTranscriptionStabilized: () => this.onStabilized(cur, run),
          onError: (err) => this.onTranscriberError(cur, err),
        },
      )
      cur.transcriber = transcriber
      cur.lastDataAt = Date.now()
      await transcriber.start()
    } catch (err) {
      this.onFailure(cur, `could not start: ${err instanceof Error ? err.message : err}`)
    }
  }

  private currentMs(cur: Active): number {
    return cur.wav.durationMs
  }

  private onTranscribe(cur: Active, run: number, ev: RealtimeTranscribeEvent) {
    if (this.cur !== cur || run !== cur.run || ev.type !== 'transcribe' || !ev.data || ev.sliceIndex < 0) return
    cur.transcribeErrors = 0
    // a newer slice means older ones are done even if no "stabilized" callback came
    for (const [idx, s] of cur.slices) if (idx < ev.sliceIndex && !s.finalized) this.finalizeSlice(cur, idx)

    const raw = ev.data.result ?? ''
    const existing = cur.slices.get(ev.sliceIndex)
    const durationMs = Math.round(ev.recordingTime)
    const track: SliceTrack = existing ?? { startMs: Math.max(0, this.currentMs(cur) - durationMs), text: '', raw: '', durationMs, finalized: false }
    track.raw = raw
    track.text = cleanTranscript(raw)
    track.durationMs = durationMs
    cur.slices.set(ev.sliceIndex, track)
    this.lastTranscribed = { cur, run, sliceIndex: ev.sliceIndex }
    if (cur.showPartials && !track.finalized) this.set({ partial: track.text || null })
  }

  private lastTranscribed: { cur: Active; run: number; sliceIndex: number } | null = null

  /** Fires right after the final onTranscribe of a slice (speech ended). */
  private onStabilized(cur: Active, run: number) {
    const last = this.lastTranscribed
    if (!last || last.cur !== cur || last.run !== run) return
    this.finalizeSlice(cur, last.sliceIndex)
  }

  private finalizeSlice(cur: Active, sliceIndex: number) {
    const track = cur.slices.get(sliceIndex)
    if (!track || track.finalized) return
    track.finalized = true
    this.set({ partial: null })
    if (!track.text) return
    const seg: Segment = {
      id: `${cur.session.id}-${cur.run}-${sliceIndex}`,
      sessionId: cur.session.id,
      stream: 'mic',
      speaker: SPEAKER,
      startMs: track.startMs,
      endMs: track.startMs + track.durationMs,
      text: track.text,
      rawText: track.raw,
    }
    db.addSegment(seg)
    this.set({ segments: [...this.state.segments, seg] })
    void updateForegroundService(track.text.slice(0, 80)).catch(() => undefined)
    this.scheduleWrite(cur)
  }

  private finalizeAllSlices(cur: Active) {
    for (const idx of [...cur.slices.keys()]) this.finalizeSlice(cur, idx)
  }

  private scheduleWrite(cur: Active) {
    if (cur.writeTimer) clearTimeout(cur.writeTimer)
    cur.writeTimer = setTimeout(() => {
      const s = db.getSession(cur.session.id)
      if (s) writeTranscriptFiles(s, db.segments(s.id))
    }, 2000)
  }

  private async teardownTranscriber(cur: Active) {
    const t = cur.transcriber
    cur.transcriber = null
    if (t) await t.stop().catch(() => undefined)
  }

  // ---------------------------------------------------------------- failures & retries

  private onTranscriberError(cur: Active, err: string) {
    if (this.cur !== cur) return
    if (/audio/i.test(err)) {
      this.onFailure(cur, err)
      return
    }
    // transcription errors: tolerate a few, then reload the model
    if (++cur.transcribeErrors >= MAX_TRANSCRIBE_ERRORS) {
      cur.transcribeErrors = 0
      void resetContexts().then(() => this.onFailure(cur, `speech engine error: ${err}`))
    }
  }

  private checkStall() {
    const cur = this.cur
    if (!cur || this.state.status !== 'recording') return
    if (Date.now() - cur.lastDataAt > STALL_MS) this.onFailure(cur, 'microphone stopped delivering audio')
  }

  private onFailure(cur: Active, reason: string) {
    if (this.cur !== cur || this.state.status === 'stopping' || cur.retryTimer) return
    cur.failedAt ??= Date.now()
    this.finalizeAllSlices(cur)
    this.fire('FAILURE')
    const delay = backoffDelay(cur.attempt++)
    this.set({ message: `${reason} — retrying in ${Math.round(delay / 1000)} s`, partial: null })
    cur.retryTimer = setTimeout(async () => {
      cur.retryTimer = null
      if (this.cur !== cur) return
      await this.teardownTranscriber(cur)
      await this.runTranscriber()
    }, delay)
  }

  private onRecovered(cur: Active) {
    const wasRetrying = this.state.status === 'retrying'
    if (wasRetrying && cur.failedAt && Date.now() - cur.failedAt > 2000) {
      const gapMs = Date.now() - cur.failedAt
      const seg: Segment = {
        id: uuid(), sessionId: cur.session.id, stream: 'mic', speaker: 'Notice',
        startMs: Math.max(0, this.currentMs(cur) - gapMs), endMs: this.currentMs(cur),
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
      void this.teardownTranscriber(cur).then(() => this.runTranscriber())
    }
  }

  // ---------------------------------------------------------------- crash recovery

  /** Close sessions a crash left open and transcribe the audio after their last segment. */
  async recover(): Promise<void> {
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
      } catch {
        // recovery is best effort; the session is still closed below
      }
      db.updateSession(s.id, { status: 'interrupted', endedAt: s.startedAt + endMs })
      const updated = db.getSession(s.id)
      if (updated) writeTranscriptFiles(updated, db.segments(s.id))
    }
    this.set({ recovering: false })
  }
}

export const recorder = new Recorder()
