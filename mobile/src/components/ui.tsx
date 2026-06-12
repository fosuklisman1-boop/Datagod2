// Tiny shared UI kit — visual language mirrors the web app's dealer skin:
// purple gradient chrome (top bar / nav / primary buttons), light surfaces,
// white soft-shadow cards, pill buttons, vector icons (no emojis).
import { ReactNode, useRef } from "react"
import {
  View, Text, TextInput, StyleSheet, Pressable, TouchableOpacity,
  Animated, Platform, ActivityIndicator, ViewStyle, TextInputProps,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { LinearGradient } from "expo-linear-gradient"
import { Ionicons } from "@expo/vector-icons"
import * as Haptics from "expo-haptics"
import { useRouter } from "expo-router"
import { colors, radius, cardShadow, purpleGradient } from "@/lib/theme"

// Purple gradient top bar + light content area. `back` shows a back arrow,
// `right` renders an action (e.g. the Home bell) on the right edge.
export function Screen({
  title, children, back, right,
}: {
  title: string
  children: ReactNode
  back?: boolean
  right?: ReactNode
}) {
  const router = useRouter()
  return (
    <View style={s.root}>
      <LinearGradient colors={purpleGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
        <SafeAreaView edges={["top"]}>
          <View style={s.headerBar}>
            <View style={s.headerLeft}>
              {back && (
                <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={s.backBtn}>
                  <Ionicons name="arrow-back" size={22} color="#ffffff" />
                </TouchableOpacity>
              )}
              <Text style={s.headerTitle}>{title}</Text>
            </View>
            {right}
          </View>
        </SafeAreaView>
      </LinearGradient>
      <View style={s.content}>{children}</View>
    </View>
  )
}

// Round white-on-purple icon button for the header `right` slot.
export function HeaderIconButton({
  icon, onPress, badge,
}: {
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  badge?: number
}) {
  return (
    <TouchableOpacity style={s.headerIconBtn} onPress={onPress} hitSlop={8}>
      <Ionicons name={icon} size={20} color="#ffffff" />
      {badge != null && badge > 0 && (
        <View style={s.headerBadge}>
          <Text style={s.headerBadgeText}>{badge > 9 ? "9+" : badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>
}

// Pill button: gradient purple primary, green success CTA, soft secondary,
// outline ghost, red danger. Spring press animation + light haptic tick.
export function Button({
  label, onPress, busy, disabled, variant = "primary", icon,
}: {
  label: string
  onPress: () => void
  busy?: boolean
  disabled?: boolean
  variant?: "primary" | "secondary" | "success" | "danger" | "ghost"
  icon?: keyof typeof Ionicons.glyphMap
}) {
  const scale = useRef(new Animated.Value(1)).current
  const pressIn = () => {
    Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 50, bounciness: 4 }).start()
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    }
  }
  const pressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 50, bounciness: 4 }).start()
  }

  const fg =
    variant === "ghost" || variant === "secondary" ? colors.primary : colors.primaryForeground
  const inner = busy ? (
    <ActivityIndicator color={fg} />
  ) : (
    <View style={s.buttonInner}>
      {icon && <Ionicons name={icon} size={17} color={fg} />}
      <Text style={[s.buttonText, { color: fg }]}>{label}</Text>
    </View>
  )

  return (
    <Animated.View style={{ transform: [{ scale }], opacity: disabled || busy ? 0.5 : 1 }}>
      <Pressable onPressIn={pressIn} onPressOut={pressOut} onPress={onPress} disabled={disabled || busy}>
        {variant === "primary" ? (
          <LinearGradient
            colors={purpleGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[s.button, s.buttonShadow]}
          >
            {inner}
          </LinearGradient>
        ) : (
          <View
            style={[
              s.button,
              variant === "secondary" && { backgroundColor: `${colors.primary}1A` },
              variant === "success" && [{ backgroundColor: colors.success }, s.buttonShadow],
              variant === "danger" && [{ backgroundColor: colors.danger }, s.buttonShadow],
              variant === "ghost" && s.ghost,
            ]}
          >
            {inner}
          </View>
        )}
      </Pressable>
    </Animated.View>
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
  root: { flex: 1, backgroundColor: colors.bg },
  headerBar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  backBtn: {
    width: 34, height: 34, borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center",
  },
  headerTitle: { color: "#ffffff", fontSize: 20, fontWeight: "800" },
  headerIconBtn: {
    width: 38, height: 38, borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center",
  },
  headerBadge: {
    position: "absolute", top: -3, right: -3, backgroundColor: colors.danger,
    borderRadius: radius.full, minWidth: 17, height: 17, paddingHorizontal: 4,
    alignItems: "center", justifyContent: "center",
  },
  headerBadgeText: { color: "#ffffff", fontSize: 10, fontWeight: "800" },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  card: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.lg, padding: 16, marginBottom: 12, ...cardShadow,
  },
  button: {
    borderRadius: radius.full, paddingVertical: 14, paddingHorizontal: 18,
    alignItems: "center", marginTop: 4,
  },
  buttonInner: { flexDirection: "row", alignItems: "center", gap: 7 },
  buttonShadow: {
    shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
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
