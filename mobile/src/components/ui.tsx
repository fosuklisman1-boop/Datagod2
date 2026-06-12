// Tiny shared UI kit for v1 — keeps screens consistent without a UI library.
// Visual language mirrors the web app's "Modern Fintech" reskin: light surfaces,
// white soft-shadow cards, indigo primary, soft-fill status badges.
import { ReactNode } from "react"
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, ViewStyle, TextInputProps,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { colors, radius, cardShadow } from "@/lib/theme"

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <Text style={s.title}>{title}</Text>
      {children}
    </SafeAreaView>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>
}

export function Button({
  label, onPress, busy, disabled, variant = "primary",
}: {
  label: string
  onPress: () => void
  busy?: boolean
  disabled?: boolean
  variant?: "primary" | "danger" | "ghost"
}) {
  const bg = variant === "primary" ? colors.primary : variant === "danger" ? colors.danger : "transparent"
  const fg = variant === "ghost" ? colors.primary : colors.primaryForeground
  return (
    <TouchableOpacity
      style={[s.button, { backgroundColor: bg }, variant === "ghost" && s.ghost, (disabled || busy) && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled || busy}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, { color: fg }]}>{label}</Text>}
    </TouchableOpacity>
  )
}

export function Field(props: TextInputProps & { label?: string }) {
  return (
    <View style={{ marginBottom: 12 }}>
      {props.label ? <Text style={s.label}>{props.label}</Text> : null}
      <TextInput placeholderTextColor={colors.textMuted} {...props} style={[s.input, props.style]} />
    </View>
  )
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={{ color: colors.textMuted, fontSize: 13 }}>{children}</Text>
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <Text style={{ color: colors.danger, marginVertical: 8, textAlign: "center" }}>{children}</Text> : null
}

export function StatusBadge({ status }: { status?: string }) {
  const st = (status || "pending").toLowerCase()
  const color =
    st === "completed" || st === "delivered" ? colors.success
    : st === "failed" || st === "expired" || st === "cancelled" ? colors.danger
    : st === "processing" ? colors.primary
    : colors.warning
  // Soft fill = brand color at ~10% alpha, like the web's bg-success/10 badges.
  return (
    <View style={[s.badge, { backgroundColor: `${color}1A` }]}>
      <Text style={{ color, fontSize: 11, fontWeight: "600", textTransform: "capitalize" }}>{st}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  title: { color: colors.text, fontSize: 24, fontWeight: "800", marginTop: 8, marginBottom: 16 },
  card: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.lg, padding: 16, marginBottom: 12, ...cardShadow,
  },
  button: { borderRadius: radius.md, padding: 14, alignItems: "center", marginTop: 4 },
  ghost: { borderWidth: 1, borderColor: colors.primary },
  buttonText: { fontWeight: "700", fontSize: 15 },
  label: { color: colors.textMuted, fontSize: 13, marginBottom: 6 },
  input: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.md, color: colors.text, padding: 12, fontSize: 16,
  },
  badge: {
    borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 3,
    alignSelf: "flex-start",
  },
})
