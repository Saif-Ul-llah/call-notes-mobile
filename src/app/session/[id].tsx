import { useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { Button, Card, speakerColor } from '../../components/ui'
import * as db from '../../lib/db'
import { deleteSessionFiles, shareAudio, shareTranscript, type ShareFormat } from '../../lib/files'
import { recorder } from '../../lib/recorder'
import { isLive, useRecorder } from '../../lib/use-recorder'
import { formatClock, toParagraphs, toText } from '../../shared/transcript-format'
import { colors } from '../../theme'

function Player({ uri, seekRequest }: { uri: string; seekRequest: { ms: number; n: number } | null }) {
  const player = useAudioPlayer(uri)
  const status = useAudioPlayerStatus(player)
  useEffect(() => {
    if (!seekRequest) return
    void player.seekTo(Math.max(0, seekRequest.ms / 1000 - 0.3)).then(() => player.play())
  }, [seekRequest, player])
  const pos = Math.floor(status.currentTime ?? 0)
  const dur = Math.floor(status.duration ?? 0)
  return (
    <View style={styles.player}>
      <Button label={status.playing ? 'Pause' : 'Play'} onPress={() => (status.playing ? player.pause() : player.play())} />
      <Text style={styles.playerTime}>
        {formatClock(pos * 1000)} / {formatClock(dur * 1000)}
      </Text>
    </View>
  )
}

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const live = useRecorder()
  const [session, setSession] = useState(() => db.getSession(id))
  const [title, setTitle] = useState(session?.title ?? '')
  const [seek, setSeek] = useState<{ ms: number; n: number } | null>(null)
  const isRecordingThis = live.sessionId === id
  // live sessions re-read segments as they arrive
  const segments = useMemo(() => db.segments(id), [id, isRecordingThis ? live.segments.length : 0])

  useEffect(() => {
    setSession(db.getSession(id))
  }, [id, live.status])

  if (!session) return <Text style={styles.missing}>This call no longer exists.</Text>

  const share = (format: ShareFormat) => void shareTranscript(session, segments, format).catch((e) => Alert.alert('Share failed', String(e)))

  const remove = () =>
    Alert.alert('Delete this call?', 'The transcript and recording will be removed from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          db.deleteSession(id)
          deleteSessionFiles(session.dir)
          router.back()
        },
      },
    ])

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: isRecordingThis ? 'Live transcript' : 'Transcript' }} />
      <TextInput
        style={styles.title}
        value={title}
        onChangeText={setTitle}
        onEndEditing={() => title.trim() && db.updateSession(id, { title: title.trim() })}
      />
      <Text style={styles.meta}>
        {new Date(session.startedAt).toLocaleString()} · {session.endedAt ? formatClock(session.endedAt - session.startedAt) : 'in progress'}
        {session.status === 'interrupted' ? ' · Interrupted' : ''}
      </Text>

      {session.status === 'interrupted' && !isLive(live) && (
        <Button label="↻ Resume this call" variant="primary" onPress={() => void recorder.resume(id).then(() => router.replace('/'))} style={{ marginTop: 12 }} />
      )}

      {session.audioPath && !isRecordingThis && <Player uri={session.audioPath} seekRequest={seek} />}

      <View style={styles.actions}>
        <Button label="Share .txt" onPress={() => share('txt')} />
        <Button label=".md" onPress={() => share('md')} />
        <Button label=".srt" onPress={() => share('srt')} />
        <Button label=".json" onPress={() => share('json')} />
        <Button label="Copy" onPress={() => void Clipboard.setStringAsync(toText(session, segments))} />
        {session.audioPath && !isRecordingThis && <Button label="Share audio" onPress={() => void shareAudio(session.audioPath!)} />}
        <Button label="✦ MOM (soon)" disabled onPress={() => undefined} />
        <Button label="Delete" variant="danger" disabled={isRecordingThis} onPress={remove} />
      </View>

      <Card style={{ marginTop: 14 }}>
        {segments.length === 0 && <Text style={styles.empty}>{isRecordingThis ? 'Waiting for speech…' : 'No speech was transcribed.'}</Text>}
        {toParagraphs(segments).map((p, i) => (
          <Pressable key={i} style={styles.para} onPress={() => setSeek({ ms: p.startMs, n: Date.now() })}>
            <Text style={styles.paraTs}>{formatClock(p.startMs)}</Text>
            <View style={{ flex: 1 }}>
              {p.speaker !== 'Speaker' && <Text style={[styles.who, { color: speakerColor(p.speaker) }]}>{p.speaker}</Text>}
              <Text style={styles.paraText} selectable>
                {p.text}
              </Text>
            </View>
          </Pressable>
        ))}
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  missing: { color: colors.textDim, padding: 24 },
  title: { color: colors.goldLight, fontSize: 20, fontWeight: '700', paddingVertical: 4 },
  meta: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  player: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
  playerTime: { color: colors.textDim, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  empty: { color: colors.textFaint, textAlign: 'center', paddingVertical: 20 },
  para: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  paraTs: { color: colors.textFaint, fontSize: 12, width: 42, paddingTop: 3, fontVariant: ['tabular-nums'] },
  who: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 2 },
  paraText: { color: colors.text, fontSize: 16, lineHeight: 24 },
})
