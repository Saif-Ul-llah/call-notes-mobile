import { useCallback, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import * as db from '../lib/db'
import { useRecorder } from '../lib/use-recorder'
import { formatClock } from '../shared/transcript-format'
import { colors } from '../theme'

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
        placeholder="Search calls and transcripts…"
        placeholderTextColor={colors.textFaint}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
      />
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={<Text style={styles.empty}>{query ? 'No matches.' : 'No calls yet.'}</Text>}
        renderItem={({ item }) => {
          const live = item.id === liveId
          return (
            <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]} onPress={() => router.push(`/session/${item.id}`)}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              <View style={styles.meta}>
                <Text style={styles.metaText}>{new Date(item.startedAt).toLocaleDateString()}</Text>
                <Text style={styles.metaText}>{item.endedAt ? formatClock(item.endedAt - item.startedAt) : '—'}</Text>
                <Text style={styles.metaText}>{item.segmentCount ?? 0} lines</Text>
                {live && <Text style={[styles.badge, { color: colors.danger, borderColor: colors.danger }]}>Live</Text>}
                {item.status === 'interrupted' && <Text style={[styles.badge, { color: colors.warn, borderColor: colors.warn }]}>Interrupted</Text>}
              </View>
            </Pressable>
          )
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    marginBottom: 12,
  },
  empty: { color: colors.textFaint, textAlign: 'center', marginTop: 40 },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { flexDirection: 'row', gap: 10, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  metaText: { color: colors.textFaint, fontSize: 12 },
  badge: { fontSize: 11, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, overflow: 'hidden' },
})
