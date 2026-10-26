// whisper decode options (pure; shared by the app engine and the offline pipeline test).

import { MOBILE_MODEL, audioCtxFor } from '../shared/models'
import type { LanguageMode } from '../shared/types'

export function whisperLanguage(mode: LanguageMode): string {
  return MOBILE_MODEL.language[mode]
}

/** Extra encoder window around the speech. Measured on the golden clips: with the
 *  audio cropped to speech first, +2 s keeps accuracy (CER 3.6% vs 4.4% full window)
 *  while encoding ~4x faster; tighter windows lose words. */
export const FINAL_CTX_EXTRA_MS = 2000

/**
 * Lines: beam 3 over a window cut to the cropped speech + 2 s. Previews: greedy over a
 * window cut to the slice, on their own context and fewer threads, so they keep
 * flowing while a line is being finished.
 */
export function decodeOptions(mode: LanguageMode, kind: 'final' | 'partial', audioMs = 0) {
  const language = whisperLanguage(mode)
  if (kind === 'final') return { language, temperature: 0, beamSize: 3, bestOf: 3, maxThreads: 4, audioCtx: audioCtxFor(audioMs + FINAL_CTX_EXTRA_MS) }
  return { language, temperature: 0, beamSize: 1, bestOf: 1, maxThreads: 2, audioCtx: audioCtxFor(audioMs) }
}
