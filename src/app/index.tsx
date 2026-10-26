import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Link, Stack } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Segmented, StatusChip, speakerColor } from '../components/ui'
import * as db from '../lib/db'
import { recorder } from '../lib/recorder'
import { isLive, useElapsed, useRecorder } from '../lib/use-recorder'
import { formatClock } from '../shared/transcript-format'
import type { LanguageMode } from '../shared/types'
import { colors } from '../theme'

const LANGUAGES: Array<{ value: LanguageMode; label: string }> = [
  { value: 'roman', label: 'Roman Urdu/Hindi' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: 'Auto' },
]

function RecordButton({ live, retrying, onPress, elapsed }: { live: boolean; retrying: boolean; onPress: () => void; elapsed: number }) {
  const pulse = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!live) {
      pulse.stopAnimation()
      pulse.setValue(0)
      return
    }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: retrying ? 800 : 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [live, retrying, pulse])

  const ring = retrying ? colors.warn : colors.gold
  return (
    <View style={styles.recordWrap}>
      {live && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pulse,
            { borderColor: ring, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 0] }), transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }] },
          ]}
        />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={live ? 'Stop transcript' : 'Start transcript'}
        onPress={onPress}
        style={({ pressed }) => [styles.record, live && styles.recordLive, live && { borderColor: ring }, pressed && { transform: [{ scale: 0.96 }] }]}
      >
        {live ? <View style={styles.stopSquare} /> : <Text style={styles.recordLabel}>START</Text>}
        {live && <Text style={styles.timer}>{formatClock(elapsed * 1000)}</Text>}
      </Pressable>
    </View>
  )
}

export default function Home() {
  const state = useRecorder()
  const live = isLive(state)
  const elapsed = useElapsed(live ? state.startedAt : null)
  const insets = useSafeAreaInsets()
  const [language, setLanguage] = useState<LanguageMode>(() => db.getSettings().language)
  const listRef = useRef<FlatList>(null)

  const toggle = () => (live ? void recorder.stop() : void recorder.start())

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom + 12 }]}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerLinks}>
              <Link href="/history" style={styles.headerLink}>History</Link>
              <Link href="/settings" style={styles.headerLink}>Settings</Link>
            </View>
          ),
        }}
      />

      <View style={styles.top}>
        <StatusChip status={state.status} recovering={state.recovering} />
        <Segmented
          value={language}
          options={LANGUAGES}
          disabled={live}
          onChange={(v) => {
            setLanguage(v)
            db.setSettings({ language: v })
          }}
        />
        {state.message && <Text style={styles.message}>{state.message}</Text>}
      </View>

      <RecordButton live={live} retrying={state.status === 'retrying'} onPress={toggle} elapsed={elapsed} />

      <View style={styles.transcript}>
        <FlatList
          ref={listRef}
          data={state.segments}
          keyExtractor={(s) => s.id}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            !state.partial ? (
              <Text style={styles.empty}>
                {live
                  ? 'Listening… speak normally. For phone calls, turn on speakerphone.'
                  : 'Tap START to transcribe a meeting or a speakerphone call. Everything stays on this phone.'}
              </Text>
            ) : undefined
          }
          renderItem={({ item }) => (
            <View style={styles.line}>
              <Text style={styles.ts}>{formatClock(item.startMs)}</Text>
              <Text style={[styles.text, item.speaker === 'Notice' && { color: speakerColor('Notice') }]}>{item.text}</Text>
            </View>
          )}
          ListFooterComponent={
            state.partial ? (
              <View style={styles.line}>
                <Text style={styles.ts}>…</Text>
                <Text style={[styles.text, styles.partial]}>{state.partial}</Text>
              </View>
            ) : undefined
          }
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  headerLinks: { flexDirection: 'row', gap: 16 },
  headerLink: { color: colors.goldLight, fontSize: 15, fontWeight: '600' },
  top: { gap: 12, paddingTop: 14, alignItems: 'stretch' },
  message: { color: colors.warn, fontSize: 13, textAlign: 'center' },
  recordWrap: { alignItems: 'center', justifyContent: 'center', height: 210 },
  pulse: { position: 'absolute', width: 150, height: 150, borderRadius: 75, borderWidth: 3 },
  record: {
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: colors.gold,
    borderWidth: 3,
    borderColor: colors.goldDark,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  recordLive: { backgroundColor: '#1F1A0E' },
  recordLabel: { color: colors.onGold, fontSize: 22, fontWeight: '800', letterSpacing: 2 },
  stopSquare: { width: 40, height: 40, borderRadius: 8, backgroundColor: colors.danger },
  timer: { color: colors.goldLight, fontSize: 15, fontWeight: '700', marginTop: 10, fontVariant: ['tabular-nums'] },
  transcript: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  empty: { color: colors.textFaint, textAlign: 'center', marginTop: 28, lineHeight: 21, paddingHorizontal: 12 },
  line: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  ts: { color: colors.textFaint, fontSize: 12, width: 42, paddingTop: 2, fontVariant: ['tabular-nums'] },
  text: { color: colors.text, fontSize: 16, lineHeight: 23, flex: 1 },
  partial: { color: colors.textFaint, fontStyle: 'italic' },
})
