import { useState } from 'react'
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import * as Sharing from 'expo-sharing'
import { Button, Section, Segmented } from '../components/ui'
import * as db from '../lib/db'
import { logFile, useDiagnostics } from '../lib/diagnostics'
import { MOBILE_MODEL } from '../shared/models'
import type { LanguageMode } from '../shared/types'
import { colors, fonts, type } from '../theme'

function Row({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{label}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ true: colors.brassLo, false: colors.rule }}
        thumbColor={value ? colors.brassHi : colors.ivoryFaint}
      />
    </View>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  )
}

function Diagnostics() {
  const d = useDiagnostics()
  const ms = (v: number | null) => (v === null ? 'none yet' : `${(v / 1000).toFixed(1)} s`)
  return (
    <Section title="Diagnostics">
      <Text style={styles.hint}>Live numbers from the transcription pipeline. Start a recording to see them change.</Text>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${Math.round(d.level * 100)}%` }]} />
      </View>
      <View style={styles.stats}>
        <Stat label="Microphone" value={d.micSampleRate ? `${d.micSampleRate} Hz, ${d.micChannels} ch` : 'off'} />
        <Stat label="Audio chunks" value={`${d.chunksPerSec} per second`} />
        <Stat label="Speech detected" value={d.speaking ? 'yes' : 'no'} />
        <Stat label="Preview delay" value={ms(d.lastPartialMs)} />
        <Stat label="Line delay" value={ms(d.lastFinalMs)} />
        <Stat label="Lines waiting" value={String(d.finalsQueued)} />
      </View>
      {d.lastError && <Text style={styles.error}>Last error: {d.lastError}</Text>}
      <Button
        label="Share diagnostic log"
        onPress={() => {
          const f = logFile()
          if (!f.exists) Alert.alert('No log yet', 'Record a call first, then share the log.')
          else void Sharing.shareAsync(f.uri, { mimeType: 'text/plain', dialogTitle: 'Call Notes log' })
        }}
        style={{ marginTop: 12 }}
      />
    </Section>
  )
}

export default function Settings() {
  const [s, setS] = useState(db.getSettings)
  const update = (patch: Partial<db.MobileSettings>) => setS(db.setSettings(patch))

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
      <Section title="Transcription">
        <Text style={styles.label}>Spoken language</Text>
        <View style={{ marginVertical: 10 }}>
          <Segmented<LanguageMode>
            value={s.language}
            onChange={(v) => update({ language: v })}
            options={[
              { value: 'roman', label: 'Roman Urdu/Hindi' },
              { value: 'en', label: 'English' },
              { value: 'auto', label: 'Auto' },
            ]}
          />
        </View>
        <Text style={styles.hint}>Text is always written in English letters, the way people type Hinglish and Roman Urdu.</Text>
        <Row label="Show words while someone is talking" hint="Turn off to save battery on older phones." value={s.showPartials} onChange={(v) => update({ showPartials: v })} />
      </Section>

      <Section title="Storage">
        <Row
          label="Keep the recording"
          hint="Saves the call audio with its transcript, about 115 MB per hour. When off, audio is deleted after the call is saved."
          value={s.keepAudio}
          onChange={(v) => update({ keepAudio: v })}
        />
      </Section>

      <Diagnostics />

      <Section title="About">
        <Text style={styles.hint}>
          Speech model: {MOBILE_MODEL.label}, built into the app. Transcription runs entirely on this phone; no audio or text is sent anywhere.
        </Text>
        <Text style={[styles.hint, { marginTop: 10 }]}>
          Phones don't let apps record the other side of a phone or WhatsApp call, so Call Notes listens through the microphone. Use speakerphone,
          or place the phone near the meeting.
        </Text>
      </Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ebony },
  label: { color: colors.ivory, fontSize: type.md, fontFamily: fonts.uiSemi },
  hint: { color: colors.ivoryFaint, fontSize: type.sm, lineHeight: 20, marginTop: 2, fontFamily: fonts.ui },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  meterTrack: { height: 6, borderRadius: 3, backgroundColor: colors.lacquer2, overflow: 'hidden', marginTop: 12 },
  meterFill: { height: '100%', backgroundColor: colors.brassHi },
  stats: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, rowGap: 10 },
  stat: { width: '50%' },
  statLabel: { color: colors.ivoryFaint, fontSize: type.xs, fontFamily: fonts.ui },
  statValue: { color: colors.ivory, fontSize: type.sm, fontFamily: fonts.uiSemi, marginTop: 1 },
  error: { color: colors.warn, fontSize: type.sm, marginTop: 12, fontFamily: fonts.ui },
})
