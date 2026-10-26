import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import * as db from '../lib/db'
import { useRecorder } from '../lib/use-recorder'
import { formatClock } from '../shared/transcript-format'
import { colors, fonts, radius, type } from '../theme'

function relativeDay(ts: number): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `Today, ${time}`
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return `Yesterday, ${time}`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

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
    <View style={styles.screen}>
      <TextInput
        style={styles.search}
        placeholder="Search calls and words"
        placeholderTextColor={colors.ivoryFaint}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        accessibilityLabel="Search calls"
      />
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={<Text style={styles.empty}>{query ? 'Nothing matches that search.' : 'Your calls will appear here.'}</Text>}
        renderItem={({ item }) => {
          const live = item.id === liveId
          return (
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.lacquer2 }]}
              onPress={() => router.push(`/session/${item.id}`)}
            >
              <View style={styles.rowTop}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title}
                </Text>
                {live && <Text style={[styles.tag, { color: '#F2A29C', backgroundColor: colors.recSoft }]}>Live</Text>}
                {item.status === 'interrupted' && <Text style={[styles.tag, { color: colors.warn, backgroundColor: colors.warnSoft }]}>Interrupted</Text>}
              </View>
              <Text style={styles.snippet} numberOfLines={2}>
                {item.snippet ?? (live ? 'Listening…' : 'No speech recorded')}
              </Text>
              <View style={styles.meta}>
                <Text style={styles.metaText}>{relativeDay(item.startedAt)}</Text>
                {item.endedAt && <Text style={styles.metaText}>{formatClock(item.endedAt - item.startedAt)}</Text>}
              </View>
            </Pressable>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ebony, paddingHorizontal: 16, paddingTop: 8 },
  search: {
    backgroundColor: colors.lacquer,
    borderColor: colors.rule,
    borderWidth: 1,
    borderRadius: radius.s,
    paddingHorizontal: 14,
    minHeight: 44,
    color: colors.ivory,
    fontFamily: fonts.ui,
    fontSize: type.md,
    marginBottom: 10,
  },
  empty: { color: colors.ivoryFaint, textAlign: 'center', marginTop: 48, fontFamily: fonts.ui },
  sep: { height: 1, backgroundColor: colors.rule },
  row: { paddingVertical: 14, paddingHorizontal: 4, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, color: colors.ivory, fontSize: type.md, fontFamily: fonts.uiBold },
  tag: { fontSize: type.xs, fontFamily: fonts.uiBold, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1, overflow: 'hidden' },
  snippet: { color: colors.ivoryDim, fontSize: type.sm, lineHeight: 19, fontFamily: fonts.read },
  meta: { flexDirection: 'row', gap: 12 },
  metaText: { color: colors.ivoryFaint, fontSize: type.xs, fontFamily: fonts.ui, fontVariant: ['tabular-nums'] },
})
