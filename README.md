# Call Notes — Mobile

Offline transcription of meetings and speakerphone calls for **Android** and **iOS**, in **English** and **Roman Urdu/Hindi**. The output is always in English letters (A–Z). Built with Expo (React Native) and [whisper.rn](https://github.com/mybigday/whisper.rn). Everything runs on the phone.

Desktop app: [call-notes-desktop](https://github.com/Saif-Ul-llah/call-notes-desktop)

## Download

Get the Android APK from the [Releases page](https://github.com/Saif-Ul-llah/call-notes-mobile/releases/latest). Enable "Install unknown apps" for your browser or file manager to install it.

## Features

- **Recording:** tap the big gold **START** and pick Roman Urdu/Hindi, English or Auto. Words appear live.
- **History:** search, playback, share (.txt/.md/.srt/.json/audio), and resume interrupted calls.
- **Background:** keeps transcribing with the screen off. Android uses a microphone foreground service with a notification; iOS uses the background audio mode.
- **Retry and restart:**
  - If the microphone fails or is interrupted (for example, by a phone call), capture restarts automatically.
  - After a crash, the next launch transcribes the remaining recorded audio.
- **Call audio limitation:** iOS and Android 10+ don't let apps record the other side of phone or WhatsApp calls. Put calls on **speakerphone**, or place the phone near the meeting.

## Git setup guide (developers)

### 1. Prerequisites

| Tool | Notes |
|---|---|
| Git, Node.js 20.19+ or 22 | |
| Android | Android Studio (SDK + NDK), **or** an [Expo account](https://expo.dev/signup) for cloud builds |
| iOS | macOS + Xcode, **or** EAS cloud builds |

Expo Go **can't** run this app (whisper.rn is native code), so use a development build.

### 2. Clone and install

```bash
git clone https://github.com/Saif-Ul-llah/call-notes-mobile.git
cd call-notes-mobile
npm install
npm run fetch-models      # Swift model (57 MB) + Silero VAD into assets/models (not stored in git)
```

### 3. Run on a device

```bash
npx expo run:android      # local build (Android SDK + NDK)
npx expo run:ios          # local build (macOS + Xcode)
```

### 4. Build an APK in the cloud (no Android SDK needed)

```bash
npx eas-cli login
npx eas-cli build -p android --profile preview      # installable APK
npx eas-cli build -p android --profile development  # dev client APK for `npx expo start`
```

EAS downloads the models during the build (`eas-build-post-install`).

### 5. Test

```bash
npm test                  # unit tests (romanizer, audio helpers)
npm run typecheck
npx expo-doctor
```

### Real-speech pipeline test (optional)

This runs the live pipeline (slicer → engine queue → romanizer) on the clips in `test-audio/` at real-time pace, using whisper.cpp through a whisper.node addon:

```bash
PIPELINE=1 WHISPER_NATIVE=../call-notes-desktop/native/linux-x64-avx2/index.node npx vitest run src/lib/pipeline.test.ts
```

whisper.rn is patched with `patch-package` (`patches/`) so live previews can shorten whisper's encoder window (`audioCtx`), which makes them about 4× faster.

### Day-to-day git workflow

```bash
git checkout -b feature/my-change
npm test && npm run typecheck
git add -A && git commit -m "Describe the change"
git push -u origin feature/my-change
gh pr create --fill
```

## Project layout

```
src/app/                    screens (Expo Router): home/live, history, transcript, settings
src/lib/                    recorder (session + retry + recovery), whisper engine, SQLite, files
src/shared/                 romanizer, transcript formats, state machine (shared with desktop)
modules/call-notes-foreground/  local Expo module: Android microphone foreground service (Kotlin)
```

## Credits

Speech model: [Oriserve Whisper-Hindi2Hinglish-Swift](https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Swift) (Apache-2.0), GGML conversion by rohitag13. Also uses Silero VAD, whisper.cpp and whisper.rn.
