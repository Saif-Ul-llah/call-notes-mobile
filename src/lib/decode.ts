// whisper decode options (pure; shared by the app engine and the offline pipeline test).

import { MOBILE_MODEL, audioCtxFor } from '../shared/models'
import type { LanguageMode } from '../shared/types'

export function whisperLanguage(mode: LanguageMode): string {
  return MOBILE_MODEL.language[mode]
}

/**
 * Finals: beam 3 over the full 30 s window (accuracy). Partials: greedy over a window
 * cut to the slice length (speed) — they are previews that the final replaces.
 */
export function decodeOptions(mode: LanguageMode, kind: 'final' | 'partial', audioMs = 0) {
  const language = whisperLanguage(mode)
  if (kind === 'final') return { language, temperature: 0, beamSize: 3, bestOf: 3 }
  return { language, temperature: 0, beamSize: 1, bestOf: 1, audioCtx: audioCtxFor(audioMs) }
}
