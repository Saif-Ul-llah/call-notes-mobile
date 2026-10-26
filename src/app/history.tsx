import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import * as db from '../lib/db'
import { useRecorder } from '../lib/use-recorder'
import { formatClock } from '../shared/transcript-format'
import { RecordingBar } from '../components/RecordingBar'
import { colors, fonts, radius, type } from '../theme'

/** Heading for the day a call belongs to: Today, Yesterday, a weekday this week, or a date. */
function dayGroup(ts: number): string {
  const d = new Date(ts)
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.floor((startOfToday.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
}

const timeOfDay = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export default function History() {
  const { sessionId: liveId, segments: liveSegments } = useRecorder()
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<db.StoredSession[]>([])

  // reload on focus, on search and as live segments arrive
  useFocusEffect(
    useCallback(() => {
      setSessions(db.listSessions(query))
    }, [query, liveSegments.length]),
  )

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <RecordingBar />
      <View style={styles.screen}>
      <TextInput
        style={styles.search}
        placeholder="Search calls and words"
        placeholderTextColor={colors.textFaint}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        accessibilityLabel="Search calls"
      />
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingBottom: 24 }}

        ListEmptyComponent={<Text style={styles.empty}>{query ? 'Nothing matches that search.' : 'Your calls will appear here.'}</Text>}
        renderItem={({ item, index }) => {
          const live = item.id === liveId
          const group = dayGroup(item.startedAt)
          const newGroup = index === 0 || dayGroup(sessions[index - 1].startedAt) !== group
          return (
            <View>
            {newGroup ? <Text style={[styles.group, index === 0 && { marginTop: 4 }]}>{group}</Text> : <View style={styles.sep} />}
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.raised }]}
              onPress={() => router.push(`/session/${item.id}`)}
            >
              <View style={styles.rowTop}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title}
                </Text>
                {live && <Text style={[styles.tag, { color: colors.recText, backgroundColor: colors.recSoft }]}>Live</Text>}
                {item.status === 'interrupted' && <Text style={[styles.tag, { color: colors.warn, backgroundColor: colors.warnSoft }]}>Interrupted</Text>}
              </View>
              <Text style={styles.snippet} numberOfLines={2}>
                {item.snippet ?? (live ? 'Listening…' : 'No speech recorded')}
              </Text>
              <View style={styles.meta}>
                <Text style={styles.metaText}>{timeOfDay(item.startedAt)}</Text>
                {item.endedAt && <Text style={styles.metaText}>{formatClock(item.endedAt - item.startedAt)}</Text>}
              </View>
            </Pressable>
            </View>
          )
        }}
      />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas, paddingHorizontal: 16, paddingTop: 8 },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.s,
    paddingHorizontal: 14,
    minHeight: 44,
    color: colors.text,
    fontFamily: fonts.ui,
    fontSize: type.md,
    marginBottom: 10,
  },
  empty: { color: colors.textFaint, textAlign: 'center', marginTop: 48, fontFamily: fonts.ui },
  sep: { height: 1, backgroundColor: colors.line },
  group: { color: colors.textFaint, fontSize: type.xs, fontFamily: fonts.uiSemi, marginTop: 18, marginBottom: 2, paddingHorizontal: 4 },
  row: { paddingVertical: 14, paddingHorizontal: 4, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: colors.text, fontSize: type.md, fontFamily: fonts.uiBold },
  tag: { fontSize: type.xs, fontFamily: fonts.uiBold, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1, overflow: 'hidden' },
  snippet: { color: colors.textDim, fontSize: type.sm, lineHeight: 19, fontFamily: fonts.read },
  meta: { flexDirection: 'row', gap: 12 },
  metaText: { color: colors.textFaint, fontSize: type.xs, fontFamily: fonts.ui, fontVariant: ['tabular-nums'] },
})
