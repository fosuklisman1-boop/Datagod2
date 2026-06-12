import { useCallback, useState } from "react"
import { FlatList, Text, View, TouchableOpacity, StyleSheet, RefreshControl } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useFocusEffect, useRouter } from "expo-router"
import { Card, Muted, StatusBadge } from "@/components/ui"
import { getWithdrawals, type WithdrawalRecord } from "@/lib/datagod"
import { colors } from "@/lib/theme"

function methodLabel(method: string) {
  return method === "bank_transfer" ? "Bank Transfer" : "Mobile Money"
}

export default function WithdrawalsScreen() {
  const router = useRouter()
  const [items, setItems] = useState<WithdrawalRecord[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems(await getWithdrawals())
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? "Failed to load withdrawals")
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Text style={s.back}>‹</Text>
        </TouchableOpacity>
        <Text style={s.title}>Withdrawal History</Text>
        <View style={{ width: 20 }} />
      </View>

      {error ? <Text style={s.error}>{error}</Text> : null}

      <FlatList
        data={items}
        keyExtractor={(w) => w.id}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true)
              await load()
              setRefreshing(false)
            }}
            tintColor={colors.primary}
          />
        }
        renderItem={({ item }) => (
          <Card style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.amount}>GHS {Number(item.amount).toFixed(2)}</Text>
              <Muted>{methodLabel(item.withdrawal_method)}</Muted>
              {item.net_amount != null && (
                <Muted>You receive GHS {Number(item.net_amount).toFixed(2)}</Muted>
              )}
              <Muted>{new Date(item.created_at).toLocaleString()}</Muted>
            </View>
            <StatusBadge status={item.status} />
          </Card>
        )}
        ListEmptyComponent={<Card><Muted>No withdrawals yet.</Muted></Card>}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16 },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginTop: 8, marginBottom: 16,
  },
  back: { color: colors.text, fontSize: 32, fontWeight: "600", marginTop: -4 },
  title: { color: colors.text, fontSize: 20, fontWeight: "800" },
  error: { color: colors.danger, marginBottom: 12, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center" },
  amount: { color: colors.text, fontSize: 17, fontWeight: "800", marginBottom: 2 },
})
