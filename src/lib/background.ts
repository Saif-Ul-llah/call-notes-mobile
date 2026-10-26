// Keeps transcription alive with the screen off, and hosts the floating mic bubble.
// Android: our local Expo module runs a foreground service of type "microphone"
// (required since Android 14). While the floating mic is on, the service stays up in
// standby so a tap on the bubble can start the microphone from any app.
// iOS: the "audio" background mode (expo-audio plugin) keeps the app alive while recording.

import ForegroundService from '../../modules/call-notes-foreground'

const RECORDING_TITLE = 'Call Notes is transcribing'
const STANDBY_TITLE = 'Call Notes floating mic is on'
const STANDBY_TEXT = 'Tap the mic bubble to transcribe. Long-press it to open the app.'

let standby = false

export async function startForegroundService(): Promise<void> {
  ForegroundService?.start(RECORDING_TITLE, 'Listening on this device. Tap to open.')
}

export async function updateForegroundService(text: string): Promise<void> {
  ForegroundService?.update(RECORDING_TITLE, text)
}

/** Recording ended: keep the service in standby while the floating mic is on. */
export async function stopForegroundService(): Promise<void> {
  if (standby) ForegroundService?.start(STANDBY_TITLE, STANDBY_TEXT)
  else ForegroundService?.stop()
}

/** Floating mic needs the service running so the bubble can start the mic from other apps. */
export function setStandby(on: boolean, recording: boolean): void {
  standby = on
  if (recording) return
  if (on) ForegroundService?.start(STANDBY_TITLE, STANDBY_TEXT)
  else ForegroundService?.stop()
}
