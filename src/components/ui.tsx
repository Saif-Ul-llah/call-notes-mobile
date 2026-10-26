import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import type { SessionState } from '../shared/session-state'
import { colors, fonts, radius, type } from '../theme'

export function T({ style, children, ...rest }: { style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number; selectable?: boolean }) {
  return (
    <Text style={[styles.text, style]} {...rest}>
      {children}
    </Text>
  )
}

export function Button({
  label, onPress, variant = 'default', disabled, style, icon,
}: {
  label: string
  onPress: () => void
  variant?: 'default' | 'brass' | 'rec' | 'quiet'
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  icon?: ReactNode
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        variant === 'brass' && styles.btnBrass,
        variant === 'rec' && styles.btnRec,
        variant === 'quiet' && styles.btnQuiet,
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      {icon}
      <Text style={[styles.btnText, variant === 'brass' && { color: colors.ebony, fontFamily: fonts.uiBold }, variant === 'rec' && { color: '#F2A29C' }]}>
        {label}
      </Text>
    </Pressable>
  )
}

export function Segmented<V extends string>({
  value, options, onChange, disabled,
}: { value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void; disabled?: boolean }) {
  return (
    <View style={[styles.segmented, disabled && { opacity: 0.5 }]} accessibilityRole="radiogroup">
      {options.map((o) => {
        const active = o.value === value
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled }}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={[styles.segItem, active && styles.segItemActive]}
          >
            <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function StatusPill({ status, recovering }: { status: SessionState; recovering?: boolean }) {
  const map: Record<string, { label: string; fg: string; bg: string }> = {
    recording: { label: 'Listening', fg: '#F2A29C', bg: colors.recSoft },
    starting: { label: 'Starting', fg: colors.brassHi, bg: colors.lacquer2 },
    retrying: { label: 'Reconnecting', fg: colors.warn, bg: colors.warnSoft },
    stopping: { label: 'Saving', fg: colors.brassHi, bg: colors.lacquer2 },
  }
  const s = map[status] ?? (recovering ? { label: 'Recovering last call', fg: colors.warn, bg: colors.warnSoft } : { label: 'Ready', fg: colors.ok, bg: colors.lacquer2 })
  return (
    <View style={[styles.pill, { backgroundColor: s.bg }]} accessibilityRole="text" accessibilityLabel={`Status: ${s.label}`}>
      <View style={[styles.dot, { backgroundColor: status === 'recording' ? colors.rec : s.fg }]} />
      <Text style={[styles.pillText, { color: s.fg }]}>{s.label}</Text>
    </View>
  )
}

export function Section({ title, children, style }: { title?: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.section, style]}>
      {title && <Text style={styles.sectionTitle}>{title}</Text>}
      {children}
    </View>
  )
}

export const speakerColor = (speaker: string) => (speaker === 'Notice' ? colors.warn : speaker === 'Me' ? colors.brassHi : colors.sage)

const styles = StyleSheet.create({
  text: { color: colors.ivory, fontFamily: fonts.ui, fontSize: type.md },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    minHeight: 42,
    paddingHorizontal: 14,
    borderRadius: radius.s,
    borderWidth: 1,
    borderColor: colors.rule,
    backgroundColor: colors.lacquer2,
  },
  btnBrass: { backgroundColor: colors.brass, borderColor: colors.brassLo },
  btnRec: { backgroundColor: 'transparent', borderColor: '#6B2C27' },
  btnQuiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
  btnText: { color: colors.ivory, fontFamily: fonts.uiSemi, fontSize: type.sm },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.lacquer,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.rule,
    padding: 3,
  },
  segItem: { flex: 1, minHeight: 38, justifyContent: 'center', borderRadius: radius.s, alignItems: 'center', paddingHorizontal: 4 },
  segItemActive: { backgroundColor: colors.brass },
  segText: { color: colors.ivoryDim, fontSize: type.sm, fontFamily: fonts.uiSemi },
  segTextActive: { color: colors.ebony, fontFamily: fonts.uiBold },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', paddingHorizontal: 11, height: 26, borderRadius: radius.pill },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: type.sm, fontFamily: fonts.uiSemi },
  section: {
    backgroundColor: colors.lacquer,
    borderRadius: radius.m,
    borderWidth: 1,
    borderColor: colors.rule,
    padding: 16,
  },
  sectionTitle: { color: colors.brassHi, fontSize: type.md, fontFamily: fonts.uiBold, marginBottom: 12 },
})
