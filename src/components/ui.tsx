import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import type { SessionState } from '../shared/session-state'
import { colors, radius } from '../theme'

export function Button({
  label, onPress, variant = 'default', disabled, style,
}: { label: string; onPress: () => void; variant?: 'default' | 'primary' | 'danger'; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        variant === 'primary' && styles.btnPrimary,
        variant === 'danger' && styles.btnDanger,
        pressed && { opacity: 0.75 },
        disabled && { opacity: 0.4 },
        style,
      ]}
    >
      <Text style={[styles.btnText, variant === 'primary' && { color: colors.onGold, fontWeight: '700' }]}>{label}</Text>
    </Pressable>
  )
}

export function Segmented<T extends string>({
  value, options, onChange, disabled,
}: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <View style={[styles.segmented, disabled && { opacity: 0.5 }]}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled }}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={[styles.segItem, active && styles.segItemActive]}
          >
            <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function StatusChip({ status, recovering }: { status: SessionState; recovering?: boolean }) {
  const map: Record<string, { label: string; color: string }> = {
    recording: { label: 'Listening', color: colors.danger },
    starting: { label: 'Starting…', color: colors.goldLight },
    retrying: { label: 'Retrying', color: colors.warn },
    stopping: { label: 'Saving…', color: colors.goldLight },
  }
  const s = map[status] ?? (recovering ? { label: 'Recovering…', color: colors.warn } : { label: 'Ready', color: colors.ok })
  return (
    <View style={[styles.chip, { borderColor: s.color + '66' }]}>
      <View style={[styles.dot, { backgroundColor: s.color }]} />
      <Text style={[styles.chipText, { color: s.color }]}>{s.label}</Text>
    </View>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>
}

export const speakerColor = (speaker: string) =>
  speaker === 'Notice' ? colors.warn : speaker === 'Me' ? colors.goldLight : colors.text

const styles = StyleSheet.create({
  btn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
    alignItems: 'center',
  },
  btnPrimary: { backgroundColor: colors.gold, borderColor: colors.goldDark },
  btnDanger: { borderColor: '#5a2224' },
  btnText: { color: colors.text, fontSize: 14 },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 3,
  },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: radius.sm, alignItems: 'center' },
  segItemActive: { backgroundColor: colors.gold },
  segText: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  segTextActive: { color: colors.onGold },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { fontSize: 12, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
  },
})
