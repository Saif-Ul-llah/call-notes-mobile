// Floating mic bubble over other apps (Android "Display over other apps"), like a
// picture-in-picture player: tap to start/stop, drag to move, long-press to open the app.

import { AppState, Platform } from 'react-native'
import { getRecordingPermissionsAsync } from 'expo-audio'
import ForegroundService from '../../modules/call-notes-foreground'
import * as db from './db'
import { log } from './diagnostics'
import { setStandby } from './background'
import { recorder } from './recorder'

export const bubbleSupported = Platform.OS === 'android' && !!ForegroundService

let wired = false

export function hasOverlayPermission(): boolean {
  return !!ForegroundService?.canDrawOverlays()
}

export function openOverlayPermission(): void {
  ForegroundService?.openOverlaySettings()
}

const isRecording = () => {
  const s = recorder.getState().status
  return s === 'starting' || s === 'recording' || s === 'retrying' || s === 'stopping'
}

/** Show or hide the bubble to match the setting and permission. */
export async function syncBubble(): Promise<void> {
  if (!bubbleSupported || !ForegroundService) return
  const want = db.getSettings().floatingMic && hasOverlayPermission()
  try {
    if (want) {
      // The standby service must start while the app is visible (Android 12+), and a
      // microphone-type service started without mic permission crashes the app (Android 14).
      const mic = await getRecordingPermissionsAsync()
      if (AppState.currentState === 'active' && mic.granted) setStandby(true, isRecording())
      await ForegroundService.showBubble()
      await ForegroundService.setBubbleRecording(isRecording())
    } else {
      setStandby(false, isRecording())
      await ForegroundService.hideBubble()
    }
  } catch (err) {
    log('error', `floating mic: ${err}`)
  }
}

/** Wire bubble taps to the recorder and keep the bubble's look in sync. Call once at startup. */
export function initBubble(): void {
  if (!bubbleSupported || !ForegroundService || wired) return
  wired = true
  ForegroundService.addListener('onBubblePress', () => {
    if (isRecording()) void recorder.stop()
    else void recorder.start()
  })
  let last = isRecording()
  recorder.subscribe(() => {
    const now = isRecording()
    if (now !== last) {
      last = now
      void ForegroundService!.setBubbleRecording(now).catch(() => undefined)
    }
  })
  // permission is granted in system settings: re-check when the user comes back
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void syncBubble()
  })
  void syncBubble()
}
