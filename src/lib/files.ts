// On-device storage: per-session folders with the WAV recording and transcript files.

import { Directory, File, FileMode, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { toMarkdown, toSrt, toText, toTranscriptDoc } from '../shared/transcript-format'
import type { Segment, SessionInfo } from '../shared/types'
import { HEADER_BYTES, wavHeader } from './wav'

export function newSessionDir(id: string, date: Date): Directory {
  const pad = (n: number) => String(n).padStart(2, '0')
  const dir = new Directory(
    Paths.document,
    'CallNotes',
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}-${id.slice(0, 8)}`,
  )
  dir.create({ intermediates: true, idempotent: true })
  return dir
}

/**
 * Streams 16 kHz mono PCM into a WAV file. The header is rewritten every few seconds,
 * so a crash leaves a playable file (and repairHeader() fixes any remainder).
 */
export class WavWriter {
  private handle: ReturnType<File['open']>
  private dataBytes = 0
  private lastHeaderAt = 0

  constructor(readonly file: File) {
    if (!file.exists) file.create({ intermediates: true })
    this.handle = file.open(FileMode.ReadWrite)
    const existing = file.size ?? 0
    if (existing < HEADER_BYTES) {
      this.handle.writeBytesSync(wavHeader(0))
    } else {
      // continuing a session (e.g. after a capture restart): append to the end
      this.dataBytes = existing - HEADER_BYTES
    }
    this.handle.offset = HEADER_BYTES + this.dataBytes
  }

  get durationMs(): number {
    return Math.floor(this.dataBytes / 32)
  }

  append(pcm: Uint8Array): void {
    this.handle.writeBytesSync(pcm)
    this.dataBytes += pcm.length
    if (Date.now() - this.lastHeaderAt > 5000) this.writeHeader()
  }

  private writeHeader(): void {
    this.lastHeaderAt = Date.now()
    this.handle.offset = 0
    this.handle.writeBytesSync(wavHeader(this.dataBytes))
    this.handle.offset = HEADER_BYTES + this.dataBytes
  }

  close(): void {
    try {
      this.writeHeader()
    } finally {
      this.handle.close()
    }
  }

  /** Fix the size fields of a WAV left behind by a crash. */
  static repairHeader(file: File): void {
    if (!file.exists || (file.size ?? 0) < HEADER_BYTES) return
    const h = file.open(FileMode.ReadWrite)
    try {
      const data = (file.size ?? HEADER_BYTES) - HEADER_BYTES
      h.offset = 0
      h.writeBytesSync(wavHeader(data - (data % 2)))
    } finally {
      h.close()
    }
  }

  static readRange(file: File, offset: number, length: number): Uint8Array {
    const h = file.open(FileMode.ReadOnly)
    try {
      h.offset = offset
      return h.readBytesSync(length)
    } finally {
      h.close()
    }
  }
}

export function writeTranscriptFiles(session: SessionInfo, segs: Segment[]): void {
  const dir = new Directory(session.dir)
  if (!dir.exists) return
  const md = new File(dir, 'transcript.md')
  const json = new File(dir, 'transcript.json')
  md.write(toMarkdown(session, segs))
  json.write(JSON.stringify(toTranscriptDoc(session, segs), null, 2))
}

export type ShareFormat = 'txt' | 'md' | 'srt' | 'json'

export async function shareTranscript(session: SessionInfo, segs: Segment[], format: ShareFormat): Promise<void> {
  const content =
    format === 'md' ? toMarkdown(session, segs)
    : format === 'srt' ? toSrt(segs)
    : format === 'json' ? JSON.stringify(toTranscriptDoc(session, segs), null, 2)
    : toText(session, segs)
  const safe = session.title.replace(/[^\w\- ,()]+/g, '').trim() || 'transcript'
  const file = new File(Paths.cache, `${safe}.${format}`)
  file.write(content)
  await Sharing.shareAsync(file.uri, { dialogTitle: session.title })
}

export async function shareAudio(path: string): Promise<void> {
  await Sharing.shareAsync(new File(path).uri, { mimeType: 'audio/wav' })
}

export function deleteSessionFiles(dirPath: string): void {
  const dir = new Directory(dirPath)
  if (dir.exists) dir.delete()
}
