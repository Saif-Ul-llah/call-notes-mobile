import { useState } from 'react'
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { Card, Segmented } from '../components/ui'
import * as db from '../lib/db'
import { MOBILE_MODEL } from '../shared/models'
import type { LanguageMode } from '../shared/types'
import { colors } from '../theme'

function Row({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{label}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.goldDark, false: colors.border }} thumbColor={value ? colors.gold : '#888'} />
    </View>
  )
}

export default function Settings() {
  const [s, setS] = useState(db.getSettings)
  const update = (patch: Partial<db.MobileSettings>) => setS(db.setSettings(patch))

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Card>
        <Text style={styles.section}>Transcription</Text>
        <Text style={styles.label}>Language</Text>
        <View style={{ marginVertical: 8 }}>
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
        <Text style={styles.hint}>Output is always in English letters (A–Z), like Google voice typing.</Text>
        <Row label="Live preview" hint="Show words while someone is still speaking" value={s.showPartials} onChange={(v) => update({ showPartials: v })} />
      </Card>

      <Card>
        <Text style={styles.section}>Storage</Text>
        <Row
          label="Keep audio recordings"
          hint="Saves a WAV recording with each transcript (about 115 MB per hour). When off, audio is deleted once the call is saved."
          value={s.keepAudio}
          onChange={(v) => update({ keepAudio: v })}
        />
      </Card>

      <Card>
        <Text style={styles.section}>About</Text>
        <Text style={styles.hint}>
          Speech model: {MOBILE_MODEL.label} (whisper.cpp), bundled in the app. Transcription runs fully offline — no audio or text leaves this phone.
        </Text>
        <Text style={[styles.hint, { marginTop: 8 }]}>
          Phones don't let apps record the other side of a cellular or WhatsApp call, so Call Notes listens through the microphone: put calls on
          speakerphone, or place the phone near the meeting.
        </Text>
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  section: { color: colors.gold, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 10 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.textFaint, fontSize: 13, lineHeight: 19, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 },
})
