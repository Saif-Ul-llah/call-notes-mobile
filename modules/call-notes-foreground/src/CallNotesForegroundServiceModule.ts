import { NativeModule, requireOptionalNativeModule } from 'expo'

declare class CallNotesForegroundServiceModule extends NativeModule<{}> {
  start(title: string, text: string): void
  update(title: string, text: string): void
  stop(): void
}

// Android only: iOS keeps recording alive with the "audio" background mode instead.
export default requireOptionalNativeModule<CallNotesForegroundServiceModule>('CallNotesForegroundService')
