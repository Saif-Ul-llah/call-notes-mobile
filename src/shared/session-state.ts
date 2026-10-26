// Session lifecycle state machine. Persisted to the DB on every transition so a crash
// always leaves a clear status behind (anything not "saved" on launch = interrupted).

import type { SessionStatus } from './types'

export type SessionState = SessionStatus | 'idle'

export type SessionEvent =
  | 'START' // user pressed start
  | 'STARTED' // capture + engine running
  | 'FAILURE' // capture or engine failed, will retry
  | 'RECOVERED' // retry succeeded
  | 'STOP' // user pressed stop
  | 'STOPPED' // everything flushed and saved
  | 'CRASH_DETECTED' // found unfinished on launch
  | 'RESET' // back to idle after saved/interrupted

const TRANSITIONS: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  idle: { START: 'starting' },
  starting: { STARTED: 'recording', FAILURE: 'retrying', STOP: 'stopping', CRASH_DETECTED: 'interrupted' },
  recording: { FAILURE: 'retrying', STOP: 'stopping', CRASH_DETECTED: 'interrupted' },
  retrying: { RECOVERED: 'recording', FAILURE: 'retrying', STOP: 'stopping', CRASH_DETECTED: 'interrupted' },
  stopping: { STOPPED: 'saved', CRASH_DETECTED: 'interrupted' },
  saved: { RESET: 'idle' },
  interrupted: { RESET: 'idle', STOPPED: 'saved' },
}

export function transition(state: SessionState, event: SessionEvent): SessionState {
  const next = TRANSITIONS[state][event]
  if (!next) throw new Error(`invalid session transition: ${state} --${event}-->`)
  return next
}

export function canTransition(state: SessionState, event: SessionEvent): boolean {
  return TRANSITIONS[state][event] !== undefined
}

/** States that mean a session was still live; found at launch they indicate a crash. */
export const LIVE_STATES: readonly SessionStatus[] = ['starting', 'recording', 'retrying', 'stopping']

/** Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, 30s, 30s... */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 30000, jitter = 0.2): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
  const spread = raw * jitter
  return Math.round(raw - spread + Math.random() * spread * 2)
}
