// whisper.cpp contexts (whisper.rn) for the bundled offline models, with retry/reset.

import { Platform } from 'react-native'
import { initWhisper, initWhisperVad, type WhisperContext, type WhisperVadContext } from 'whisper.rn'
import ForegroundService from '../../modules/call-notes-foreground'
import { cleanTranscript } from '../shared/romanizer'
import { backoffDelay } from '../shared/session-state'
import { CROP_PAD_AFTER_MS, CROP_PAD_BEFORE_MS } from '../shared/models'
import type { LanguageMode } from '../shared/types'
import { cropToSpeech } from './crop'
import { log } from './diagnostics'
import { decodeOptions } from './decode'

export { decodeOptions } from './decode'

// Bundled with the app (metro.config.js adds the .bin asset extension).
const MODEL_ASSET = require('../../assets/models/ggml-hinglish-swift-q5_1.bin')
const VAD_ASSET = require('../../assets/models/ggml-silero-v5.1.2.bin')

export interface Contexts {
  /** finishes lines (accurate settings) */
  whisper: WhisperContext
  /** live previews run on their own context so they never wait behind a line */
  preview: WhisperContext
  vad: WhisperVadContext
  /** extra contexts so two lines are transcribed at once on 8-core phones */
  workers: WhisperContext[]
}

/** Parallel line workers beyond the first: 8 cores fit two 4-thread jobs; each context needs ~150 MB. */
function extraWorkers(): number {
  if (Platform.OS === 'ios') return 1
  const info = ForegroundService?.deviceInfo()
  return info && info.cores >= 8 && info.memoryMb >= 2500 ? 1 : 0
}

let contexts: Contexts | null = null
let loading: Promise<Contexts> | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Load (once) the model and VAD; retries with backoff because a load can fail under memory pressure. */
export function getContexts(): Promise<Contexts> {
  if (contexts) return Promise.resolve(contexts)
  if (loading) return loading
  loading = (async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const t = Date.now()
        const whisper = await initWhisper({ filePath: MODEL_ASSET, useGpu: true })
        const preview = await initWhisper({ filePath: MODEL_ASSET, useGpu: true })
        const vad = await initWhisperVad({ filePath: VAD_ASSET, useGpu: false, nThreads: 1 })
        const workers: WhisperContext[] = []
        for (let i = extraWorkers(); i > 0; i--) workers.push(await initWhisper({ filePath: MODEL_ASSET, useGpu: true }))
        contexts = { whisper, preview, vad, workers }
        log('info', `speech model loaded in ${Date.now() - t} ms (${1 + workers.length} line workers)`)
        return contexts
      } catch (err) {
        lastError = err
        await sleep(backoffDelay(attempt))
      }
    }
    throw new Error(`could not load the speech model: ${lastError}`)
  })().finally(() => {
    loading = null
  })
  return loading
}

/** Drop the contexts after a native error so the next getContexts() reloads them. */
export async function resetContexts(): Promise<void> {
  const old = contexts
  contexts = null
  await Promise.allSettled([old?.whisper.release(), old?.preview.release(), old?.vad.release(), ...(old?.workers ?? []).map((w) => w.release())])
}

/**
 * Offline transcription of a block of 16 kHz PCM (crash recovery): Silero VAD gate,
 * crop to speech, then whisper. Returns '' when there is no speech.
 */
export async function transcribePcm(pcm: ArrayBuffer, mode: LanguageMode): Promise<{ text: string; raw: string }> {
  const { whisper, vad } = await getContexts()
  const speech = await vad.detectSpeechData(pcm, { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100 })
  if (speech.length === 0) return { text: '', raw: '' }
  const audio = cropToSpeech(pcm, speech, CROP_PAD_BEFORE_MS, CROP_PAD_AFTER_MS)
  // the encoder window must cover the whole block, or whisper only hears its first seconds
  const { promise } = whisper.transcribeData(audio, { ...decodeOptions(mode, 'final', audio.byteLength / 32), beamSize: 5, bestOf: 5 })
  const result = await promise
  return { text: cleanTranscript(result.result), raw: result.result }
}
