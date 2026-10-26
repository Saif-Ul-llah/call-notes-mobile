// Live pipeline diagnostics (shown in Settings and as the mic level meter) and a small
// rolling log file the user can share, so a device-specific problem is diagnosable.

import { useSyncExternalStore } from 'react'
import { Directory, File, Paths } from 'expo-file-system'

export interface Diagnostics {
  /** mic level 0..1 (RMS, smoothed) */
  level: number
  micSampleRate: number | null
  micChannels: number | null
  chunksPerSec: number
  /** speech detected by the slicer right now */
  speaking: boolean
  lastPartialMs: number | null
  lastFinalMs: number | null
  finalsQueued: number
  lastError: string | null
}

let state: Diagnostics = {
  level: 0, micSampleRate: null, micChannels: null, chunksPerSec: 0, speaking: false,
  lastPartialMs: null, lastFinalMs: null, finalsQueued: 0, lastError: null,
}
const listeners = new Set<() => void>()

export function updateDiagnostics(patch: Partial<Diagnostics>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function useDiagnostics(): Diagnostics {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
}

// ---- log file

const MAX_LOG_BYTES = 256 * 1024
const pending: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function logFile(): File {
  return new File(Paths.document, 'CallNotes', 'log.txt')
}

function flush(): void {
  flushTimer = null
  try {
    const dir = new Directory(Paths.document, 'CallNotes')
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
    const file = logFile()
    if (!file.exists) file.create()
    const text = pending.splice(0).join('')
    if ((file.size ?? 0) > MAX_LOG_BYTES) {
      // keep the newest half when the log grows too big
      const old = file.textSync()
      file.write(old.slice(old.length / 2) + text)
    } else {
      file.write(text, { append: true })
    }
  } catch {
    // logging must never break transcription
  }
}

export function log(level: 'info' | 'warn' | 'error', message: string): void {
  pending.push(`${new Date().toISOString()} [${level}] ${message}\n`)
  if (level === 'error') updateDiagnostics({ lastError: message })
  if (!flushTimer) flushTimer = setTimeout(flush, 1000)
}
