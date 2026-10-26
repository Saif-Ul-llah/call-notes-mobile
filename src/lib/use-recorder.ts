import { useEffect, useState, useSyncExternalStore } from 'react'
import { recorder, type RecorderState } from './recorder'

export function useRecorder(): RecorderState {
  return useSyncExternalStore(recorder.subscribe, recorder.getState)
}

export function isLive(s: RecorderState): boolean {
  return s.status === 'starting' || s.status === 'recording' || s.status === 'retrying' || s.status === 'stopping'
}

/** Seconds since `startedAt`, ticking every second. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
}
