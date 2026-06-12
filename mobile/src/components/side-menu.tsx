// Slide-in side menu, opened by tapping the active bottom tab again — same
// gesture as the web app's "Tap the active tab again to open the side menu".
// In-app destinations route natively; everything else opens inside the
// authenticated WebView (/web), so ALL web features are available in-app.
import { useEffect, useRef, useState } from "react"
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Animated,
  Dimensions, ScrollView, Alert,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { LinearGradient } from "expo-linear-gradient"
import { Ionicons } from "@expo/vector-icons"
import { useRouter } from "expo-router"
import { supabase } from "@/lib/supabase"
import { unregisterPush } from "@/lib/push"
import { colors, radius, purpleGradient } from "@/lib/theme"

const MENU_WIDTH = Math.min(Dimensions.get("window").width * 0.78, 320)

type Item = {
  label: string
  icon: keyof typeof Ionicons.glyphMap
  route?: string // in-app expo-router path
  web?: string // web dashboard path
}

const ITEMS: Item[] = [
  { label: "Dashboard", icon: "grid-outline", route: "/" },
  { label: "Buy Data", icon: "wifi-outline", route: "/data" },
  { label: "Buy Airtime", icon: "call-outline", route: "/airtime" },
  { label: "Wallet", icon: "wallet-outline", route: "/wallet" },
  { label: "My Orders", icon: "receipt-outline", route: "/orders" },
  { label: "Notifications", icon: "notifications-outline", route: "/notifications" },
  { label: "Withdrawals", icon: "cash-outline", route: "/withdrawals" },
  { label: "Profile", icon: "person-outline", route: "/profile" },
  { label: "Results Checker", icon: "school-outline", web: "/dashboard/results-checker" },
  { label: "My Shop", icon: "storefront-outline", web: "/dashboard/my-shop" },
  { label: "Shop Dashboard", icon: "trending-up-outline", web: "/dashboard/shop-dashboard" },
  { label: "Sub-Agents", icon: "people-outline", web: "/dashboard/sub-agents" },
  { label: "Sub-Agent Catalog", icon: "albums-outline", web: "/dashboard/sub-agent-catalog" },
  { label: "AFA Orders", icon: "star-outline", web: "/dashboard/afa-orders" },
  { label: "Transactions", icon: "time-outline", web: "/dashboard/transactions" },
  { label: "My Complaints", icon: "alert-circle-outline", web: "/dashboard/complaints" },
  { label: "USSD Shop", icon: "keypad-outline", web: "/dashboard/ussd-shop" },
  { label: "Payment Reverify", icon: "refresh-circle-outline", web: "/dashboard/payment-reverify" },
  { label: "Upgrade to Dealer", icon: "sparkles-outline", web: "/dashboard/upgrade" },
]

export function SideMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter()
  const slide = useRef(new Animated.Value(-MENU_WIDTH)).current
  const [email, setEmail] = useState("")

  useEffect(() => {
    if (visible) {
      supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""))
      Animated.timing(slide, { toValue: 0, duration: 220, useNativeDriver: true }).start()
    } else {
      slide.setValue(-MENU_WIDTH)
    }
  }, [visible, slide])

  const open = (item: Item) => {
    onClose()
    if (item.route) {
      router.push(item.route as any)
    } else if (item.web) {
      // Opens inside the app, already signed in (session handoff in /web).
      router.push({ pathname: "/web", params: { path: item.web, title: item.label } } as any)
    }
  }

  const logout = () => {
    onClose()
    Alert.alert("Log out", "Sign out of this device?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: async () => {
          await unregisterPush()
          supabase.auth.signOut({ scope: "local" })
        },
      },
    ])
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdropWrap}>
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onClose} />
        <Animated.View style={[s.panel, { transform: [{ translateX: slide }] }]}>
          <LinearGradient colors={purpleGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            <SafeAreaView edges={["top"]}>
              <View style={s.header}>
                <View style={s.avatar}>
                  <Ionicons name="person" size={22} color="#ffffff" />
                </View>
                <Text style={s.headerTitle}>DATAGOD</Text>
                <Text style={s.headerEmail} numberOfLines={1}>{email}</Text>
              </View>
            </SafeAreaView>
          </LinearGradient>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 8 }}>
            {ITEMS.map((item) => (
              <TouchableOpacity key={item.label} style={s.item} onPress={() => open(item)}>
                <View style={s.itemIcon}>
                  <Ionicons name={item.icon} size={18} color={colors.primary} />
                </View>
                <Text style={s.itemLabel}>{item.label}</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            ))}

            <View style={s.divider} />
            <TouchableOpacity style={s.item} onPress={logout}>
              <View style={[s.itemIcon, { backgroundColor: `${colors.danger}14` }]}>
                <Ionicons name="log-out-outline" size={18} color={colors.danger} />
              </View>
              <Text style={[s.itemLabel, { color: colors.danger }]}>Log Out</Text>
            </TouchableOpacity>
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdropWrap: { flex: 1, flexDirection: "row" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15,23,42,0.45)",
  },
  panel: {
    width: MENU_WIDTH, backgroundColor: colors.card, height: "100%",
    borderTopRightRadius: radius.lg, borderBottomRightRadius: radius.lg,
    overflow: "hidden",
  },
  header: { padding: 18, paddingBottom: 22 },
  avatar: {
    width: 44, height: 44, borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center",
    marginBottom: 10,
  },
  headerTitle: { color: "#ffffff", fontSize: 18, fontWeight: "800", letterSpacing: 2 },
  headerEmail: { color: "rgba(255,255,255,0.8)", fontSize: 12, marginTop: 2 },
  item: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 11,
  },
  itemIcon: {
    width: 34, height: 34, borderRadius: radius.full,
    backgroundColor: `${colors.primary}14`, alignItems: "center", justifyContent: "center",
  },
  itemLabel: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8, marginHorizontal: 16 },
})
