import { useSyncExternalStore } from 'react'
import * as db from './db'

// Settings shared across screens (text size, floating mic) with change notification.
let current = db.getSettings()
const listeners = new Set<() => void>()

export function updateSettings(patch: Partial<db.MobileSettings>): db.MobileSettings {
  current = db.setSettings(patch)
  listeners.forEach((l) => l())
  return current
}

export function useSettings(): db.MobileSettings {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
}
