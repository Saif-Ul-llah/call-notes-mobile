import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { recorder } from '../lib/recorder'
import { isLive, useElapsed, useRecorder } from '../lib/use-recorder'
import { formatClock } from '../shared/transcript-format'
import { colors, fonts, type } from '../theme'

/** Slim bar shown on every screen except Home while a call is being transcribed. */
export function RecordingBar() {
  const state = useRecorder()
  const live = isLive(state)
  const elapsed = useElapsed(live ? state.startedAt : null)
  if (!live) return null
  const label = state.status === 'retrying' ? 'Reconnecting' : state.status === 'stopping' ? 'Saving' : 'Recording'
  return (
    <View style={styles.bar}>
      <Pressable style={styles.info} onPress={() => router.navigate('/')} accessibilityRole="button" accessibilityLabel="Open live transcript">
        <View style={[styles.dot, state.status === 'retrying' && { backgroundColor: colors.warn }]} />
        <Text style={styles.text}>
          {label} {formatClock(elapsed * 1000)}
        </Text>
        <Text style={styles.link}>Show live</Text>
      </Pressable>
      <Pressable
        style={styles.stop}
        onPress={() => void recorder.stop()}
        disabled={state.status === 'stopping'}
        accessibilityRole="button"
        accessibilityLabel="Stop transcript"
      >
        <View style={styles.stopIcon} />
        <Text style={styles.stopText}>Stop</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.recSoft,
    borderBottomWidth: 1,
    borderBottomColor: '#4A2224',
  },
  info: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.rec },
  text: { color: '#F2A29C', fontFamily: fonts.uiSemi, fontSize: type.sm, fontVariant: ['tabular-nums'] },
  link: { color: colors.brassHi, fontFamily: fonts.uiSemi, fontSize: type.sm, marginLeft: 'auto' },
  stop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    minHeight: 36,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#6B2C27',
  },
  stopIcon: { width: 10, height: 10, borderRadius: 2, backgroundColor: colors.rec },
  stopText: { color: '#F2A29C', fontFamily: fonts.uiSemi, fontSize: type.sm },
})
