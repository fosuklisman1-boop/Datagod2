import { useCallback, useState } from "react"
import { ScrollView, RefreshControl, Text, View, TouchableOpacity, StyleSheet } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useFocusEffect, useRouter } from "expo-router"
import { LinearGradient } from "expo-linear-gradient"
import { Card, Muted, StatusBadge } from "@/components/ui"
import { getWalletBalance, getOrders, type Order, type WalletBalance } from "@/lib/datagod"
import { unreadCount } from "@/lib/notifications"
import { supabase } from "@/lib/supabase"
import { colors, radius, cardShadow } from "@/lib/theme"

export default function HomeScreen() {
  const router = useRouter()
  const [wallet, setWallet] = useState<WalletBalance | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [email, setEmail] = useState("")
  const [unread, setUnread] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [{ data: auth }, balance, recent, count] = await Promise.all([
        supabase.auth.getUser(),
        getWalletBalance(),
        getOrders(1, 5),
        unreadCount().catch(() => 0),
      ])
      setEmail(auth.user?.email ?? "")
      setWallet(balance)
      setOrders(recent)
      setUnread(count)
    } catch {
      // Errors surface on the dedicated tabs; home stays calm.
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  const onRefresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <View style={s.headerRow}>
        <Text style={s.headerTitle}>Datagod</Text>
        <TouchableOpacity style={s.bell} onPress={() => router.push("/notifications")} hitSlop={8}>
          <Text style={{ fontSize: 20 }}>🔔</Text>
          {unread > 0 && (
            <View style={s.bellBadge}>
              <Text style={s.bellBadgeText}>{unread > 9 ? "9+" : unread}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        <Muted>{email}</Muted>

        {/* Wallet hero — same indigo→violet gradient as the web dashboard. */}
        <LinearGradient
          colors={[colors.primary, colors.violet]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={s.hero}
        >
          <View style={s.heroCircle} />
          <Text style={s.heroLabel}>Wallet Balance</Text>
          <Text style={s.balance}>GHS {(wallet?.balance ?? 0).toFixed(2)}</Text>
          <Text style={s.heroHint}>Available funds</Text>
          <View style={s.heroActions}>
            <TouchableOpacity style={s.heroBtnSolid} onPress={() => router.push("/wallet")}>
              <Text style={s.heroBtnSolidText}>＋ Top Up</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.heroBtnGhost} onPress={() => router.push("/data")}>
              <Text style={s.heroBtnGhostText}>Buy Data</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.heroBtnGhost} onPress={() => router.push("/orders")}>
              <Text style={s.heroBtnGhostText}>My Orders</Text>
            </TouchableOpacity>
          </View>
        </LinearGradient>

        <View style={s.quickRow}>
          <QuickAction label="Buy Data" emoji="📶" onPress={() => router.push("/data")} />
          <QuickAction label="Airtime" emoji="📞" onPress={() => router.push("/airtime")} />
          <QuickAction label="Top Up" emoji="💰" onPress={() => router.push("/wallet")} />
        </View>

        <Text style={s.section}>Recent orders</Text>
        {orders.length === 0 ? (
          <Card><Muted>No orders yet.</Muted></Card>
        ) : (
          orders.map((o) => (
            <Card key={o.id} style={s.orderCard}>
              <View style={{ flex: 1 }}>
                <Text style={s.orderTitle}>
                  {o.network ?? ""} {o.size ?? ""}
                </Text>
                <Muted>
                  {o.phone_number ?? ""} · {new Date(o.created_at).toLocaleDateString()}
                </Muted>
              </View>
              <StatusBadge status={o.order_status ?? o.status} />
            </Card>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function QuickAction({ label, emoji, onPress }: { label: string; emoji: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.quick} onPress={onPress}>
      <Text style={{ fontSize: 22 }}>{emoji}</Text>
      <Text style={s.quickLabel}>{label}</Text>
    </TouchableOpacity>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  headerRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginTop: 8, marginBottom: 16,
  },
  headerTitle: { color: colors.text, fontSize: 24, fontWeight: "800" },
  bell: {
    backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.full, width: 40, height: 40,
    alignItems: "center", justifyContent: "center", ...cardShadow,
  },
  bellBadge: {
    position: "absolute", top: -4, right: -4, backgroundColor: colors.danger,
    borderRadius: radius.full, minWidth: 18, height: 18, paddingHorizontal: 4,
    alignItems: "center", justifyContent: "center",
  },
  bellBadgeText: { color: "#ffffff", fontSize: 10, fontWeight: "800" },
  hero: {
    borderRadius: radius.lg, padding: 20, marginTop: 12, marginBottom: 12,
    overflow: "hidden",
  },
  heroCircle: {
    position: "absolute", right: -40, top: -48, width: 192, height: 192,
    borderRadius: 96, backgroundColor: "rgba(255,255,255,0.1)",
  },
  heroLabel: { color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: "600" },
  balance: { color: "#ffffff", fontSize: 36, fontWeight: "800", marginTop: 6, fontVariant: ["tabular-nums"] },
  heroHint: { color: "rgba(255,255,255,0.75)", fontSize: 12, marginTop: 2 },
  heroActions: { flexDirection: "row", gap: 8, marginTop: 18 },
  heroBtnSolid: {
    backgroundColor: "#ffffff", borderRadius: radius.md,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  heroBtnSolidText: { color: colors.violet, fontWeight: "700", fontSize: 13 },
  heroBtnGhost: {
    backgroundColor: "rgba(255,255,255,0.15)", borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  heroBtnGhostText: { color: "#ffffff", fontWeight: "600", fontSize: 13 },
  quickRow: { flexDirection: "row", gap: 10, marginBottom: 8 },
  quick: {
    flex: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.lg, alignItems: "center", paddingVertical: 14, gap: 4,
    ...cardShadow,
  },
  quickLabel: { color: colors.text, fontSize: 12, fontWeight: "600" },
  section: { color: colors.text, fontSize: 16, fontWeight: "700", marginVertical: 10 },
  orderCard: { flexDirection: "row", alignItems: "center" },
  orderTitle: { color: colors.text, fontWeight: "600", marginBottom: 2 },
})
