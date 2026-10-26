// Turns any whisper output into Latin-script text (A-Z, digits, basic punctuation),
// the way Google voice typing writes Hinglish / Roman Urdu.
// NOTE: this folder is kept identical in desktop/ and mobile/ — change both.

import { devanagariToRoman } from './devanagari'
import { urduToRoman } from './urdu'

export { devanagariToRoman } from './devanagari'
export { urduToRoman } from './urdu'

/** Spelling variants produced by transliteration -> the common Roman Urdu/Hindi spelling. */
const SPELLING: Record<string, string> = {
  men: 'mein', nahin: 'nahi', nahiin: 'nahi', hamen: 'humein', tumhen: 'tumhein', unhen: 'unhein',
  inhen: 'inhein', mujhako: 'mujhko', kyaa: 'kya', han: 'haan', ham: 'hum',
  achchha: 'acha', achha: 'acha', thik: 'theek', yah: 'yeh', vah: 'woh', vo: 'woh', ye: 'yeh',
  karen: 'karein', len: 'lein', den: 'dein', jaen: 'jayein', aaen: 'aayein', bahut: 'bohat',
  dhanyavad: 'dhanyavaad', shukriyaa: 'shukriya', kyon: 'kyun', abhee: 'abhi',
}

const PHANTOM_PHRASES = [
  /thanks? (you )?for watching/i,
  /please (like|subscribe)/i,
  /like and subscribe/i,
  /subtitles? (by|from)/i,
  /amara\.org/i,
  /^\s*(\[|\()?\s*(music|applause|silence|blank_audio|no speech|inaudible|laughs?)\s*(\]|\))?\s*\.?\s*$/i,
  /^\s*(you|bye\.?)\s*$/i,
]

const NON_LATIN_SCRIPT = /[^\x00-\x7F]/

/** Strip anything that is not printable ASCII after folding accents/quotes to plain letters. */
export function toAscii(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\n]/g, '')
}

function normalizeSpelling(text: string): string {
  return text.replace(/[A-Za-z]+/g, (w) => {
    const hit = SPELLING[w.toLowerCase()]
    if (!hit) return w
    return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()
      ? hit[0].toUpperCase() + hit.slice(1)
      : hit
  })
}

/** Collapse whisper's repetition loops ("ok ok ok ok ok ..." / repeated phrases). */
export function collapseRepeats(text: string, maxRepeats = 2): string {
  let words = text.split(/\s+/).filter(Boolean)
  const gramAt = (i: number, n: number) => words.slice(i, i + n).join(' ').toLowerCase()
  for (let n = 1; n <= 6; n++) {
    const out: string[] = []
    let i = 0
    while (i < words.length) {
      if (i + n <= words.length) {
        const gram = gramAt(i, n)
        let reps = 1
        while (i + (reps + 1) * n <= words.length && gramAt(i + reps * n, n) === gram) reps++
        if (reps > maxRepeats) {
          out.push(...words.slice(i, i + maxRepeats * n))
          i += reps * n
          continue
        }
      }
      out.push(words[i])
      i++
    }
    words = out
  }
  return words.join(' ')
}

export function isPhantom(text: string): boolean {
  const t = text.trim()
  return t.length === 0 || PHANTOM_PHRASES.some((re) => re.test(t))
}

export interface RomanizeOptions {
  /** Map transliterated spellings to the common Roman Urdu/Hindi spelling (default true). */
  normalize?: boolean
}

/** Convert whisper output to Latin-only Roman Urdu/Hindi/English text. */
export function romanize(text: string, opts: RomanizeOptions = {}): string {
  // only words that were transliterated get spelling normalization, so English
  // words that look like variants (men, ham, den) are left alone
  let out = text.replace(/\S+/g, (token) => {
    if (!NON_LATIN_SCRIPT.test(token)) return token
    const roman = toAscii(urduToRoman(devanagariToRoman(token)))
    return opts.normalize === false ? roman : normalizeSpelling(roman)
  })
  out = collapseRepeats(out)
  return out
    .replace(/\s+([.,?!;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Full post-processing for a whisper segment; returns '' for hallucinated/empty output. */
export function cleanTranscript(text: string): string {
  const roman = romanize(text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, (m) => (isPhantom(m) ? '' : m)))
  return isPhantom(roman) ? '' : roman
}
