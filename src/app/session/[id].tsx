import { useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { Button, speakerColor } from '../../components/ui'
import * as db from '../../lib/db'
import { deleteSessionFiles, shareAudio, shareTranscript, type ShareFormat } from '../../lib/files'
import { recorder } from '../../lib/recorder'
import { isLive, useRecorder } from '../../lib/use-recorder'
import { formatClock, toParagraphs, toText } from '../../shared/transcript-format'
import { RecordingBar } from '../../components/RecordingBar'
import { useSettings } from '../../lib/use-settings'
import { colors, fonts, radius, type } from '../../theme'

const LANGUAGE_LABEL = { roman: 'Roman Urdu/Hindi', en: 'English', auto: 'Auto-detect' } as const

function Player({ uri, seekRequest }: { uri: string; seekRequest: { ms: number; n: number } | null }) {
  const player = useAudioPlayer(uri)
  const status = useAudioPlayerStatus(player)
  useEffect(() => {
    if (!seekRequest) return
    void player.seekTo(Math.max(0, seekRequest.ms / 1000 - 0.3)).then(() => player.play())
  }, [seekRequest, player])
  const pos = status.currentTime ?? 0
  const dur = status.duration ?? 0
  return (
    <View style={styles.player}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause' : 'Play recording'}
        onPress={() => (status.playing ? player.pause() : player.play())}
        style={styles.playBtn}
      >
        {status.playing ? (
          <View style={styles.pauseIcon}>
            <View style={styles.pauseBar} />
            <View style={styles.pauseBar} />
          </View>
        ) : (
          <View style={styles.playIcon} />
        )}
      </Pressable>
      <View style={styles.progress}>
        <View style={[styles.progressFill, { width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }]} />
      </View>
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
  const { textScale } = useSettings()
  // live sessions re-read their lines as they arrive
  const segments = useMemo(() => db.segments(id), [id, isRecordingThis ? live.segments.length : 0])

  useEffect(() => {
    setSession(db.getSession(id))
  }, [id, live.status])

  if (!session) return <Text style={styles.missing}>This call was deleted.</Text>

  const share = (format: ShareFormat) => void shareTranscript(session, segments, format).catch((e) => Alert.alert('Could not share', String(e)))
  const chooseShare = () =>
    Alert.alert('Share transcript', 'Choose a format', [
      { text: 'Plain text', onPress: () => share('txt') },
      { text: 'Markdown notes', onPress: () => share('md') },
      { text: 'Subtitles (.srt)', onPress: () => share('srt') },
      { text: 'JSON for AI tools', onPress: () => share('json') },
      { text: 'Cancel', style: 'cancel' },
    ])

  const remove = () =>
    Alert.alert('Delete this call?', 'The transcript and recording are removed from this phone.', [
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

  const length = session.endedAt ? formatClock(session.endedAt - session.startedAt) : isRecordingThis ? 'Recording' : 'Unfinished'

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: isRecordingThis ? 'Live transcript' : 'Transcript' }} />
      {!isRecordingThis && <RecordingBar />}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        <TextInput
          style={styles.title}
          value={title}
          accessibilityLabel="Call title"
          onChangeText={setTitle}
          onEndEditing={() => title.trim() && db.updateSession(id, { title: title.trim() })}
        />
        <View style={styles.facts}>
          <View>
            <Text style={styles.factLabel}>Started</Text>
            <Text style={styles.factValue}>{new Date(session.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Text>
          </View>
          <View>
            <Text style={styles.factLabel}>Length</Text>
            <Text style={styles.factValue}>{length}</Text>
          </View>
          <View>
            <Text style={styles.factLabel}>Language</Text>
            <Text style={styles.factValue}>{LANGUAGE_LABEL[session.language]}</Text>
          </View>
        </View>

        {session.status === 'interrupted' && !isLive(live) && (
          <Button label="Continue this call" variant="brass" onPress={() => void recorder.resume(id).then(() => router.replace('/'))} style={{ marginBottom: 12 }} />
        )}

        {session.audioPath && !isRecordingThis && <Player uri={session.audioPath} seekRequest={seek} />}

        <View style={styles.actions}>
          <Button label="Share" variant="brass" onPress={chooseShare} style={{ flex: 1 }} />
          <Button label="Copy text" onPress={() => void Clipboard.setStringAsync(toText(session, segments))} style={{ flex: 1 }} />
          {session.audioPath && !isRecordingThis && <Button label="Audio" onPress={() => void shareAudio(session.audioPath!)} />}
        </View>
        <View style={styles.actions}>
          <Button label="Write minutes (coming soon)" disabled onPress={() => undefined} style={{ flex: 1 }} />
          <Button label="Delete" variant="rec" disabled={isRecordingThis} onPress={remove} />
        </View>

        <View style={styles.transcript}>
          {segments.length === 0 && (
            <Text style={styles.none}>{isRecordingThis ? 'Listening. Lines appear here after each sentence.' : 'No speech was recorded in this call.'}</Text>
          )}
          {toParagraphs(segments).map((p, i) => (
            <Pressable key={i} style={styles.para} onPress={() => setSeek({ ms: p.startMs, n: Date.now() })} accessibilityHint="Plays the recording from here">
              <Text style={styles.paraTs}>{formatClock(p.startMs)}</Text>
              <View style={{ flex: 1 }}>
                {p.speaker !== 'Speaker' && <Text style={[styles.who, { color: speakerColor(p.speaker) }]}>{p.speaker}</Text>}
                <Text
                  style={[styles.paraText, { fontSize: type.read * textScale, lineHeight: 27 * textScale }, p.speaker === 'Notice' && { color: colors.warn, fontSize: type.sm }]}
                  selectable
                >
                  {p.text}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ebony },
  missing: { color: colors.ivoryDim, padding: 24, fontFamily: fonts.ui },
  title: { color: colors.ivory, fontSize: type.xl, fontFamily: fonts.uiBold, paddingVertical: 4 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 22, marginTop: 6, marginBottom: 16 },
  factLabel: { color: colors.ivoryFaint, fontSize: type.xs, fontFamily: fonts.ui },
  factValue: { color: colors.ivoryDim, fontSize: type.sm, fontFamily: fonts.uiSemi, marginTop: 1 },
  player: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: radius.m,
    backgroundColor: colors.lacquer,
    borderWidth: 1,
    borderColor: colors.rule,
    marginBottom: 12,
  },
  playBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.brass, alignItems: 'center', justifyContent: 'center' },
  playIcon: {
    marginLeft: 3,
    width: 0,
    height: 0,
    borderLeftWidth: 13,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    borderLeftColor: colors.ebony,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  pauseIcon: { flexDirection: 'row', gap: 4 },
  pauseBar: { width: 4, height: 15, borderRadius: 1, backgroundColor: colors.ebony },
  progress: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.lacquer2, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.brassHi },
  playerTime: { color: colors.ivoryDim, fontSize: type.xs, fontFamily: fonts.ui, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  transcript: { marginTop: 14, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.rule },
  none: { color: colors.ivoryFaint, textAlign: 'center', paddingVertical: 20, fontFamily: fonts.ui },
  para: { flexDirection: 'row', gap: 12, marginBottom: 18 },
  paraTs: { color: colors.ivoryFaint, fontSize: type.xs, width: 40, paddingTop: 4, fontFamily: fonts.ui, fontVariant: ['tabular-nums'] },
  who: { fontSize: type.sm, fontFamily: fonts.uiBold, marginBottom: 2 },
  paraText: { color: colors.ivory, fontSize: type.read, lineHeight: 27, fontFamily: fonts.read },
})
