import { useEffect } from 'react'
import { View } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useFonts } from 'expo-font'
import { Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold } from '@expo-google-fonts/manrope'
import {
  AtkinsonHyperlegible_400Regular,
  AtkinsonHyperlegible_400Regular_Italic,
  AtkinsonHyperlegible_700Bold,
} from '@expo-google-fonts/atkinson-hyperlegible'
import { initBubble } from '../lib/bubble'
import { recorder } from '../lib/recorder'
import { colors, fonts } from '../theme'

export default function RootLayout() {
  // fonts ship inside the app bundle: no network needed
  const [loaded] = useFonts({
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    AtkinsonHyperlegible_400Regular,
    AtkinsonHyperlegible_400Regular_Italic,
    AtkinsonHyperlegible_700Bold,
  })

  useEffect(() => {
    // close sessions a crash left open and transcribe their remaining audio
    void recorder.recover()
    initBubble()
  }, [])

  if (!loaded) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.chrome },
          headerTintColor: colors.goldHi,
          headerTitleStyle: { fontFamily: fonts.uiBold, color: colors.text },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.canvas },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Call Notes' }} />
        <Stack.Screen name="history" options={{ title: 'Your calls' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'Transcript' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
  )
}
