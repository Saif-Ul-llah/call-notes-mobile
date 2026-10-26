// Bundled whisper.cpp models on mobile.
// Only the Swift Hinglish model ships on phones: the Apex model (large-v3-turbo) needs
// ~25 s for a 5 s clip even on a Snapdragon 8 Elite, far too slow for live transcription.

import type { LanguageMode } from './types'

export const MOBILE_MODEL = {
  id: 'swift' as const,
  label: 'Hinglish Swift',
  // Oriserve Whisper-Hindi2Hinglish-Swift (whisper-base fine-tune), q5_1, 57 MB.
  // Must decode with "en": forcing "hi" makes it fall back to Devanagari.
  language: { roman: 'en', en: 'en', auto: 'en' } satisfies Record<LanguageMode, string>,
}

/** Silero VAD crop padding, same values as the desktop engine (tuned on golden clips). */
export const CROP_PAD_BEFORE_MS = 450
export const CROP_PAD_AFTER_MS = 750

/**
 * Encoder window for a live preview (whisper's audio_ctx; 1500 = 30 s, 50 per second).
 * Encoding only the slice length makes previews ~4x faster; finals keep the full
 * window because shortening it costs accuracy. Needs patches/whisper.rn+*.patch.
 */
export function audioCtxFor(audioMs: number): number {
  return Math.min(1500, Math.max(384, Math.ceil((((audioMs + 1000) / 1000) * 50) / 64) * 64))
}
