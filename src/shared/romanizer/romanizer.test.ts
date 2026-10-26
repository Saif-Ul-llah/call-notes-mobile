import { describe, expect, it } from 'vitest'
import { cleanTranscript, collapseRepeats, devanagariToRoman, isPhantom, romanize, urduToRoman } from './index'

const ASCII_ONLY = /^[\x20-\x7E]*$/

describe('devanagariToRoman', () => {
  it.each([
    ['क्या', 'kya'],
    ['है', 'hai'],
    ['हैं', 'hain'],
    ['आप', 'aap'],
    ['ठीक', 'theek'],
    ['घर', 'ghar'],
    ['करना', 'karna'],
    ['समझना', 'samajhna'],
    ['रहना', 'rahna'],
    ['कहा', 'kaha'],
    ['था', 'tha'],
    ['जी', 'ji'],
    ['मैं', 'main'],
    ['हिंदी', 'hindi'],
    ['ज़रूर', 'zaroor'],
    ['फ़ोन', 'fon'],
    ['न', 'na'],
    ['१२३', '123'],
  ])('%s -> %s', (input, expected) => {
    expect(devanagariToRoman(input)).toBe(expected)
  })
})

describe('urduToRoman', () => {
  it.each([
    ['کیا', 'kya'],
    ['ہے', 'hai'],
    ['نہیں', 'nahi'],
    ['آپ', 'aap'],
    ['ٹھیک', 'theek'],
    ['شکریہ', 'shukriya'],
    ['کام', 'kaam'],
    ['۱۲۳', '123'],
  ])('%s -> %s', (input, expected) => {
    expect(urduToRoman(input)).toBe(expected)
  })

  it('always produces latin text for unknown words', () => {
    expect(urduToRoman('کرسی')).toMatch(/^[a-z]+$/)
  })
})

describe('romanize', () => {
  it('converts mixed Devanagari + English to Hinglish', () => {
    expect(romanize('मैं meeting में हूँ, क्या आप बाद में call करेंगे?')).toBe(
      'main meeting mein hoon, kya aap baad mein call karenge?',
    )
  })

  it('converts Urdu sentences with Urdu punctuation', () => {
    expect(romanize('آپ کیا کر رہے ہیں؟')).toMatch(/^aap kya kar .+ hain\?$/)
  })

  it('leaves already-roman text untouched (including English look-alikes)', () => {
    const s = 'Haan theek hai, the men will send it to the den tomorrow.'
    expect(romanize(s)).toBe(s)
  })

  it('folds accents and smart quotes to ASCII', () => {
    expect(romanize('Café “quoted” don’t – ok…')).toBe('Cafe "quoted" don\'t - ok...')
  })

  it('never emits non-ASCII characters', () => {
    const inputs = ['नमस्ते दोस्तों 🙏', 'السلام علیکم بھائی', 'ñandú 中文 текст', 'ঠিক আছে']
    for (const s of inputs) expect(romanize(s)).toMatch(ASCII_ONLY)
  })
})

describe('collapseRepeats', () => {
  it('collapses word loops', () => {
    expect(collapseRepeats('ok ok ok ok ok fine')).toBe('ok ok fine')
  })
  it('collapses phrase loops', () => {
    expect(collapseRepeats('theek hai theek hai theek hai theek hai')).toBe('theek hai theek hai')
  })
  it('keeps normal text', () => {
    expect(collapseRepeats('main ghar ja raha hoon')).toBe('main ghar ja raha hoon')
  })
})

describe('hallucination filtering', () => {
  it.each(['Thanks for watching!', '[Music]', '(silence)', '[BLANK_AUDIO]', 'you', '  '])('drops %j', (s) => {
    expect(isPhantom(s)).toBe(true)
    expect(cleanTranscript(s)).toBe('')
  })
  it('strips bracketed noise tags but keeps speech', () => {
    expect(cleanTranscript('[Music] haan bhai kaise ho')).toBe('haan bhai kaise ho')
  })
})
