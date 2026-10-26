import { NativeModule, requireOptionalNativeModule } from 'expo'

type Events = {
  onBubblePress(): void
}

declare class CallNotesForegroundServiceModule extends NativeModule<Events> {
  start(title: string, text: string): void
  update(title: string, text: string): void
  stop(): void
  canDrawOverlays(): boolean
  openOverlaySettings(): void
  showBubble(): Promise<boolean>
  hideBubble(): Promise<void>
  setBubbleRecording(recording: boolean): Promise<void>
}

// Android only: iOS keeps recording alive with the "audio" background mode and does not
// allow apps to draw over other apps.
export default requireOptionalNativeModule<CallNotesForegroundServiceModule>('CallNotesForegroundService')
