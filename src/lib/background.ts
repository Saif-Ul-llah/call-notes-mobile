// Keeps transcription alive with the screen off.
// Android: our local Expo module runs a foreground service of type "microphone"
// (required since Android 14) with a persistent notification.
// iOS: the "audio" background mode (expo-audio plugin) keeps the app alive while recording.

import ForegroundService from '../../modules/call-notes-foreground'

const TITLE = 'Call Notes is transcribing'

export async function startForegroundService(): Promise<void> {
  ForegroundService?.start(TITLE, 'Listening on this device. Tap to open.')
}

export async function updateForegroundService(text: string): Promise<void> {
  ForegroundService?.update(TITLE, text)
}

export async function stopForegroundService(): Promise<void> {
  ForegroundService?.stop()
}
