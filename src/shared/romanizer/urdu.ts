// Urdu (Perso-Arabic script) -> Roman Urdu.
// Urdu omits short vowels, so common words come from a dictionary and the rest
// use letter mapping with a simple vowel-insertion heuristic.

const COMMON_WORDS: Record<string, string> = {
  ہے: 'hai', ہیں: 'hain', ہوں: 'hoon', ہو: 'ho', ہوا: 'hua', ہوئی: 'hui', ہوئے: 'hue',
  تھا: 'tha', تھی: 'thi', تھے: 'thay', تھیں: 'thin',
  میں: 'main', مجھے: 'mujhe', میرا: 'mera', میری: 'meri', میرے: 'mere',
  ہم: 'hum', ہمیں: 'humein', ہمارا: 'hamara', ہماری: 'hamari', ہمارے: 'hamare',
  آپ: 'aap', آپکا: 'aapka', تم: 'tum', تمہیں: 'tumhein', تمہارا: 'tumhara',
  وہ: 'woh', یہ: 'yeh', اس: 'is', اسے: 'ise', ان: 'in', انہیں: 'unhein', انکا: 'unka', اسکا: 'iska',
  کیا: 'kya', کیوں: 'kyun', کب: 'kab', کہاں: 'kahan', کون: 'kaun', کیسے: 'kaise', کیسا: 'kaisa', کتنا: 'kitna',
  نہیں: 'nahi', نہ: 'na', ہاں: 'haan', جی: 'ji', ٹھیک: 'theek', اچھا: 'acha', اچھی: 'achi',
  اور: 'aur', یا: 'ya', لیکن: 'lekin', مگر: 'magar', پھر: 'phir', بھی: 'bhi', تو: 'to', ہی: 'hi',
  کے: 'ke', کی: 'ki', کا: 'ka', کو: 'ko', سے: 'se', پر: 'par', تک: 'tak', والا: 'wala', والی: 'wali', والے: 'wale',
  اب: 'ab', ابھی: 'abhi', آج: 'aaj', کل: 'kal', پہلے: 'pehle', بعد: 'baad', جب: 'jab', تب: 'tab',
  بہت: 'bohat', زیادہ: 'zyada', کم: 'kam', سب: 'sab', کچھ: 'kuch', ایک: 'aik', دو: 'do', تین: 'teen',
  کر: 'kar', کرنا: 'karna', کریں: 'karein', کرو: 'karo', کرتے: 'karte', کرتا: 'karta', کرتی: 'karti',
  دیں: 'dein', دے: 'de', لے: 'le', لیں: 'lein', جا: 'ja', جائے: 'jaye', گا: 'ga', گی: 'gi', گے: 'ge',
  بات: 'baat', کام: 'kaam', وقت: 'waqt', دن: 'din', سال: 'saal', پیسے: 'paise', لوگ: 'log',
  شکریہ: 'shukriya', براہ: 'barah', مہربانی: 'meharbani', السلام: 'assalam', علیکم: 'alaikum', خدا: 'khuda', حافظ: 'hafiz',
  ٹیم: 'team', میٹنگ: 'meeting', پروجیکٹ: 'project', کلائنٹ: 'client',
}

const LETTERS: Record<string, string> = {
  ب: 'b', پ: 'p', ت: 't', ٹ: 't', ث: 's', ج: 'j', چ: 'ch', ح: 'h', خ: 'kh',
  د: 'd', ڈ: 'd', ذ: 'z', ر: 'r', ڑ: 'r', ز: 'z', ژ: 'zh', س: 's', ش: 'sh',
  ص: 's', ض: 'z', ط: 't', ظ: 'z', غ: 'gh', ف: 'f', ق: 'q', ک: 'k', ك: 'k',
  گ: 'g', ل: 'l', م: 'm', ن: 'n', ں: 'n', ہ: 'h', ه: 'h', ة: 'a',
}

const DIACRITICS: Record<string, string> = {
  'َ': 'a', // zabar
  'ِ': 'i', // zer
  'ُ': 'u', // pesh
  'ً': 'an',
  'ٍ': 'in',
  'ٌ': 'un',
  'ٰ': 'aa', // khari zabar
}

const SHADDA = 'ّ'
const SILENT = /[ْٕٔـ‌‍]/g // sukun, hamza marks, tatweel, ZWNJ/ZWJ
const ASPIRATE = 'ھ'
const VOWEL_LETTERS = new Set(['ا', 'آ', 'و', 'ی', 'ي', 'ے', 'ۓ', 'ى', 'ئ', 'ؤ', 'ع', 'ء', 'أ', 'إ'])
const URDU_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'
const PUNCT: Record<string, string> = { '۔': '.', '،': ',', '؟': '?', '؛': ';', '٪': '%' }

const ARABIC_WORD = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+/g

function isConsonant(ch: string | undefined): boolean {
  return !!ch && LETTERS[ch] !== undefined
}

function transliterateWord(raw: string): string {
  const word = raw.replace(SILENT, '')
  const dictHit = COMMON_WORDS[word.replace(/[۔،؟]/g, '')]
  if (dictHit) return dictHit + word.replace(/[^۔،؟]/g, '').replace(/./g, (c) => PUNCT[c] ?? '')

  const chars = Array.from(word)
  let out = ''
  let insertedLast = false
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const next = chars[i + 1]
    const first = i === 0
    const final = i === chars.length - 1

    if (PUNCT[ch]) { out += PUNCT[ch]; continue }
    const d = URDU_DIGITS.indexOf(ch) >= 0 ? URDU_DIGITS.indexOf(ch) : ARABIC_DIGITS.indexOf(ch)
    if (d >= 0) { out += String(d); continue }
    if (DIACRITICS[ch]) { out += DIACRITICS[ch]; insertedLast = true; continue }
    if (ch === SHADDA) { out += out.slice(-1); continue }
    if (ch === ASPIRATE) { out += 'h'; continue }

    if (VOWEL_LETTERS.has(ch)) {
      insertedLast = false
      switch (ch) {
        case 'آ': out += 'aa'; break
        case 'ا': case 'أ': case 'إ': out += first ? 'a' : final ? 'a' : 'aa'; break
        case 'و': case 'ؤ': out += first || next === 'ا' ? 'w' : 'o'; break
        case 'ی': case 'ي': case 'ى': out += first || next === 'ا' || next === 'و' ? 'y' : final ? 'i' : 'ee'; break
        case 'ے': case 'ۓ': out += 'e'; break
        case 'ئ': out += next && !VOWEL_LETTERS.has(next) ? 'i' : ''; break
        case 'ع': out += first ? 'a' : ''; break
        default: break
      }
      continue
    }

    if (isConsonant(ch)) {
      // word-final ہ after a consonant is the silent-h vowel ending (zyada, kamra)
      if ((ch === 'ہ' || ch === 'ه') && final && i > 0) { out += 'a'; continue }
      out += LETTERS[ch]
      // insert an unwritten short vowel between consonants, alternating so clusters survive (kar-na)
      const nextIsCons = isConsonant(next) && next !== 'ں'
      if (nextIsCons && !insertedLast) {
        out += 'a'
        insertedLast = true
      } else {
        insertedLast = false
      }
    }
  }
  return out.replace(/aa$/, 'a').replace(/ee$/, 'i')
}

export function urduToRoman(text: string): string {
  return text.replace(ARABIC_WORD, (word) => transliterateWord(word))
}
