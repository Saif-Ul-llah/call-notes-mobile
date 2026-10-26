// whisper.cpp contexts (whisper.rn) for the bundled offline models, with retry/reset.

import { initWhisper, initWhisperVad, type WhisperContext, type WhisperVadContext } from 'whisper.rn'
import { cleanTranscript } from '../shared/romanizer'
import { backoffDelay } from '../shared/session-state'
import { CROP_PAD_AFTER_MS, CROP_PAD_BEFORE_MS, MOBILE_MODEL } from '../shared/models'
import type { LanguageMode } from '../shared/types'
import { cropToSpeech } from './crop'

// Bundled with the app (metro.config.js adds the .bin asset extension).
const MODEL_ASSET = require('../../assets/models/ggml-hinglish-swift-q5_1.bin')
const VAD_ASSET = require('../../assets/models/ggml-silero-v5.1.2.bin')

export interface Contexts {
  whisper: WhisperContext
  vad: WhisperVadContext
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
        const whisper = await initWhisper({ filePath: MODEL_ASSET, useGpu: true })
        const vad = await initWhisperVad({ filePath: VAD_ASSET, useGpu: false, nThreads: 1 })
        contexts = { whisper, vad }
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
  await Promise.allSettled([old?.whisper.release(), old?.vad.release()])
}

export function whisperLanguage(mode: LanguageMode): string {
  return MOBILE_MODEL.language[mode]
}

/** Decode options for live slices: beam 3 balances accuracy and phone CPU. */
export function transcribeOptions(mode: LanguageMode) {
  return { language: whisperLanguage(mode), temperature: 0, beamSize: 3, bestOf: 3 }
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
  const { promise } = whisper.transcribeData(audio, { ...transcribeOptions(mode), beamSize: 5, bestOf: 5 })
  const result = await promise
  return { text: cleanTranscript(result.result), raw: result.result }
}
