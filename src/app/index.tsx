import { memo, useEffect, useRef, useState } from 'react'
import { Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Link, Stack } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Segmented, StatusPill } from '../components/ui'
import * as db from '../lib/db'
import { useDiagnostics } from '../lib/diagnostics'
import { recorder } from '../lib/recorder'
import { isLive, useElapsed, useRecorder } from '../lib/use-recorder'
import { useSettings } from '../lib/use-settings'
import { formatClock } from '../shared/transcript-format'
import type { LanguageMode, Segment } from '../shared/types'
import { colors, fonts, type } from '../theme'

// short labels fit a third of a 360 dp screen; Settings explains "Roman Urdu" covers Hindi too
const LANGUAGES: Array<{ value: LanguageMode; label: string }> = [
  { value: 'roman', label: 'Roman Urdu' },
  { value: 'en', label: 'English' },
  { value: 'auto', label: 'Auto' },
]

const DISC = 132

/** Gold ring that swells with the voice it hears. Subscribes to the level on its own. */
function LevelRing({ active, warn }: { active: boolean; warn: boolean }) {
  const { level } = useDiagnostics()
  const scale = useRef(new Animated.Value(1)).current
  useEffect(() => {
    Animated.timing(scale, { toValue: active ? 1 + level * 0.32 : 1, duration: 90, useNativeDriver: true }).start()
  }, [active, level, scale])
  if (!active) return null
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.ring, { borderColor: warn ? colors.warn : colors.goldHi, opacity: 0.35 + level * 0.65, transform: [{ scale }] }]}
    />
  )
}

function RecordButton({ live, warn, busy, onPress }: { live: boolean; warn: boolean; busy: boolean; onPress: () => void }) {
  return (
    <View style={styles.recordWrap}>
      <LevelRing active={live} warn={warn} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={busy ? 'Recovering the last call' : live ? 'Stop transcript' : 'Start transcript'}
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={onPress}
        style={({ pressed }) => [
          styles.disc,
          live && styles.discLive,
          live && warn && { borderColor: colors.warn },
          busy && { opacity: 0.55 },
          pressed && { transform: [{ scale: 0.97 }] },
        ]}
      >
        {live ? <View style={styles.stop} /> : <Text style={styles.discLabel}>{busy ? 'Wait' : 'Start'}</Text>}
      </Pressable>
    </View>
  )
}

const Line = memo(function Line({ seg, scale }: { seg: Segment; scale: number }) {
  const notice = seg.speaker === 'Notice'
  return (
    <View style={styles.line}>
      <Text style={styles.ts}>{formatClock(seg.startMs)}</Text>
      <Text style={[styles.text, { fontSize: type.read * scale, lineHeight: 26 * scale }, notice && styles.notice]}>{seg.text}</Text>
    </View>
  )
})

export default function Home() {
  const state = useRecorder()
  const live = isLive(state)
  const elapsed = useElapsed(live ? state.startedAt : null)
  const insets = useSafeAreaInsets()
  const [language, setLanguage] = useState<LanguageMode>(() => db.getSettings().language)
  const listRef = useRef<FlatList<Segment>>(null)
  const { textScale } = useSettings()
  const previews = Object.entries(state.previews)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, text]) => text)

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom + 12 }]}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerLinks}>
              <Link href="/history" style={styles.headerLink}>
                Calls
              </Link>
              <Link href="/settings" style={styles.headerLink}>
                Settings
              </Link>
            </View>
          ),
        }}
      />

      <View style={styles.top}>
        <View style={styles.statusRow}>
          <StatusPill status={state.status} recovering={state.recovering} />
          {live && <Text style={styles.timer}>{formatClock(elapsed * 1000)}</Text>}
        </View>
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

      <RecordButton
        live={live}
        warn={state.status === 'retrying'}
        busy={state.recovering && !live}
        onPress={() => (live ? void recorder.stop() : void recorder.start())}
      />
      <Text style={styles.hint}>
        {state.recovering && !live ? 'Finishing your last call first' : live ? 'Tap to stop and save' : 'For phone calls, turn on speakerphone'}
      </Text>

      <View style={styles.panel}>
        <FlatList
          ref={listRef}
          data={state.segments}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => <Line seg={item} scale={textScale} />}
          extraData={textScale}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          contentContainerStyle={{ paddingVertical: 14, flexGrow: 1 }}
          ListEmptyComponent={
            previews.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>{live ? 'Listening' : 'Nothing transcribed yet'}</Text>
                <Text style={styles.emptyText}>
                  {live
                    ? 'Speak normally. Words appear here as they are said.'
                    : 'Tap Start in a meeting or on a speakerphone call. Everything stays on this phone.'}
                </Text>
              </View>
            ) : undefined
          }
          ListFooterComponent={
            previews.length ? (
              <View style={styles.line} accessibilityLiveRegion="polite">
                <Text style={styles.ts}>now</Text>
                <Text style={[styles.text, styles.preview, { fontSize: type.read * textScale, lineHeight: 26 * textScale }]}>
                  {previews.join(' ')}
                  <Text style={styles.caret}> ▍</Text>
                </Text>
              </View>
            ) : undefined
          }
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas, paddingHorizontal: 16 },
  headerLinks: { flexDirection: 'row', gap: 18 },
  headerLink: { color: colors.goldHi, fontSize: type.md, fontFamily: fonts.uiSemi },
  top: { gap: 12, paddingTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timer: { color: colors.textDim, fontFamily: fonts.uiSemi, fontSize: type.md, fontVariant: ['tabular-nums'] },
  message: { color: colors.warn, fontSize: type.sm, fontFamily: fonts.ui },
  recordWrap: { alignItems: 'center', justifyContent: 'center', height: DISC + 64, marginTop: 6 },
  ring: { position: 'absolute', width: DISC + 22, height: DISC + 22, borderRadius: (DISC + 22) / 2, borderWidth: 3 },
  disc: {
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    backgroundColor: colors.gold,
    borderWidth: 2,
    borderColor: colors.goldLo,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  discLive: { backgroundColor: colors.navy, borderColor: colors.gold },
  discLabel: { color: colors.canvas, fontSize: 22, fontFamily: fonts.uiBold },
  stop: { width: 36, height: 36, borderRadius: 8, backgroundColor: colors.rec },
  hint: { textAlign: 'center', color: colors.textFaint, fontSize: type.sm, fontFamily: fonts.ui, marginBottom: 14 },
  panel: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 14,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, gap: 6 },
  emptyTitle: { color: colors.text, fontSize: type.lg, fontFamily: fonts.uiBold },
  emptyText: { color: colors.textFaint, fontSize: type.sm, fontFamily: fonts.ui, textAlign: 'center', lineHeight: 20 },
  line: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  ts: { color: colors.textFaint, fontSize: type.xs, width: 40, paddingTop: 4, fontFamily: fonts.ui, fontVariant: ['tabular-nums'] },
  text: { flex: 1, color: colors.text, fontSize: type.read, lineHeight: 26, fontFamily: fonts.read },
  notice: { color: colors.warn, fontSize: type.sm, lineHeight: 20 },
  preview: { color: colors.textDim, fontFamily: fonts.readItalic },
  caret: { color: colors.gold, fontFamily: fonts.read },
})
