// Devanagari -> Roman Hindi/Urdu in the informal "Hinglish" style people type
// (kya, hai, nahi, theek), not academic IAST.

const CONSONANTS: Record<string, string> = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'n',
  च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n',
  त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n', ऩ: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm',
  य: 'y', र: 'r', ऱ: 'r', ल: 'l', ळ: 'l', ऴ: 'l', व: 'v',
  श: 'sh', ष: 'sh', स: 's', ह: 'h',
  // precomposed nukta forms
  क़: 'q', ख़: 'kh', ग़: 'gh', ज़: 'z', ड़: 'r', ढ़: 'rh', फ़: 'f', य़: 'y',
}

// Consonant + nukta (U+093C) written as two code points
const NUKTA_FORMS: Record<string, string> = {
  क: 'q', ख: 'kh', ग: 'gh', ज: 'z', ड: 'r', ढ: 'rh', फ: 'f', य: 'y',
}

const INDEPENDENT_VOWELS: Record<string, string> = {
  अ: 'a', आ: 'aa', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo', ऋ: 'ri',
  ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au', ऑ: 'o', ऍ: 'e', ऎ: 'e', ऒ: 'o',
}

const MATRAS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e', 'ॆ': 'e', 'ॊ': 'o',
}

const VIRAMA = '्'
const NUKTA = '़'
const ANUSVARA = 'ं'
const CHANDRABINDU = 'ँ'
const VISARGA = 'ः'
const DIGITS = '०१२३४५६७८९'

type Unit =
  | { kind: 'cons'; roman: string; vowel: string | null; schwa: boolean; nasal: boolean }
  | { kind: 'vowel'; roman: string; nasal: boolean }

const DEVANAGARI_WORD = /[ऀ-ॿ]+/g

function parseWord(word: string): Unit[] {
  const units: Unit[] = []
  const chars = Array.from(word)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const last = units[units.length - 1]
    // a nukta is consumed by the look-ahead below; a stray one is ignored
    if (ch === NUKTA) continue
    if (CONSONANTS[ch] !== undefined) {
      let roman = CONSONANTS[ch]
      if (chars[i + 1] === NUKTA && NUKTA_FORMS[ch]) {
        roman = NUKTA_FORMS[ch]
        i++
      }
      units.push({ kind: 'cons', roman, vowel: null, schwa: true, nasal: false })
      continue
    }
    if (MATRAS[ch] !== undefined && last?.kind === 'cons') {
      last.vowel = MATRAS[ch]
      last.schwa = false
      continue
    }
    if (ch === VIRAMA && last?.kind === 'cons') {
      last.schwa = false
      continue
    }
    if (ch === ANUSVARA || ch === CHANDRABINDU) {
      if (last) last.nasal = true
      else units.push({ kind: 'vowel', roman: 'n', nasal: false })
      continue
    }
    if (ch === VISARGA) {
      units.push({ kind: 'vowel', roman: 'h', nasal: false })
      continue
    }
    if (INDEPENDENT_VOWELS[ch] !== undefined) {
      units.push({ kind: 'vowel', roman: INDEPENDENT_VOWELS[ch], nasal: false })
      continue
    }
    if (ch === 'ॐ') {
      units.push({ kind: 'vowel', roman: 'om', nasal: false })
      continue
    }
    const digit = DIGITS.indexOf(ch)
    if (digit >= 0) {
      units.push({ kind: 'vowel', roman: String(digit), nasal: false })
      continue
    }
    if (ch === '।' || ch === '॥') {
      units.push({ kind: 'vowel', roman: '.', nasal: false })
    }
  }
  return units
}

const hasVowel = (u: Unit | undefined): boolean =>
  !!u && (u.kind === 'vowel' || u.vowel !== null || u.schwa)

/**
 * Schwa deletion, applied right-to-left (the standard Hindi heuristic):
 * - word-final inherent "a" is silent (ghar, aap), except in one-letter words (na)
 * - a medial inherent "a" is silent in a V C _ C V context (kar-na, sam-ajh-na)
 */
function deleteSchwas(units: Unit[]): void {
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]
    if (u.kind !== 'cons' || !u.schwa || u.nasal) continue
    if (i === units.length - 1) {
      if (units.length > 1) u.schwa = false
      continue
    }
    const prev = units[i - 1]
    const next = units[i + 1]
    if (i > 0 && hasVowel(prev) && next?.kind === 'cons' && hasVowel(next) && (next.vowel !== null || next.schwa)) {
      // keep the cluster pronounceable: only delete when next syllable still has its vowel
      u.schwa = false
    }
  }
}

function render(units: Unit[]): string {
  let out = ''
  units.forEach((u, i) => {
    if (u.kind === 'vowel') {
      out += u.roman
      if (u.nasal) out += 'n'
      return
    }
    out += u.roman
    if (u.vowel !== null) out += u.vowel
    else if (u.schwa) out += 'a'
    if (u.nasal) {
      const next = units[i + 1]
      const labial = next?.kind === 'cons' && /^(p|b|m)/.test(next.roman)
      out += labial ? 'm' : 'n'
    }
  })
  return out
}

/** Hinglish spelling conventions for word endings and clusters. */
function polish(word: string): string {
  return word
    .replace(/chchh/g, 'chh')
    .replace(/aa$/, 'a')
    .replace(/ee$/, 'i')
    .replace(/een$/, 'in')
}

export function devanagariToRoman(text: string): string {
  return text.replace(DEVANAGARI_WORD, (word) => {
    const units = parseWord(word)
    deleteSchwas(units)
    return polish(render(units))
  })
}
