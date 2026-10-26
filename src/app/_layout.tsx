import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { recorder } from '../lib/recorder'
import { colors } from '../theme'

export default function RootLayout() {
  useEffect(() => {
    // close sessions a crash left open and transcribe their remaining audio
    void recorder.recover()
  }, [])

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.goldLight,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Call Notes' }} />
        <Stack.Screen name="history" options={{ title: 'History' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'Transcript' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
  )
}
