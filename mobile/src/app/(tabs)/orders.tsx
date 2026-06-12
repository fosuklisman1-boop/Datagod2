import { useCallback, useState } from "react"
import { FlatList, Text, View, StyleSheet, RefreshControl } from "react-native"
import { useFocusEffect } from "expo-router"
import { Screen, Card, Muted, StatusBadge } from "@/components/ui"
import { getOrders, type Order } from "@/lib/datagod"
import { colors } from "@/lib/theme"

export default function OrdersScreen() {
  const [orders, setOrders] = useState<Order[]>([])
  const [page, setPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [end, setEnd] = useState(false)

  const load = useCallback(async (reset = false) => {
    const p = reset ? 1 : page
    const batch = await getOrders(p, 20).catch(() => [] as Order[])
    if (reset) {
      setOrders(batch)
      setPage(2)
      setEnd(batch.length < 20)
    } else {
      setOrders((prev) => [...prev, ...batch])
      setPage(p + 1)
      if (batch.length < 20) setEnd(true)
    }
  }, [page])

  useFocusEffect(
    useCallback(() => {
      load(true)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  )

  return (
    <Screen title="Orders">
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true)
              await load(true)
              setRefreshing(false)
            }}
            tintColor={colors.primary}
          />
        }
        onEndReached={async () => {
          if (end || loadingMore) return
          setLoadingMore(true)
          await load()
          setLoadingMore(false)
        }}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <Card style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.title}>
                {item.network ?? ""} {item.size ?? ""}
              </Text>
              <Muted>
                {item.phone_number ?? ""} · {new Date(item.created_at).toLocaleString()}
              </Muted>
              {item.price != null && <Muted>GHS {Number(item.price).toFixed(2)}</Muted>}
            </View>
            <StatusBadge status={item.order_status ?? item.status} />
          </Card>
        )}
        ListEmptyComponent={<Card><Muted>No orders yet — buy your first bundle from the Data tab.</Muted></Card>}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </Screen>
  )
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  title: { color: colors.text, fontWeight: "700", marginBottom: 2 },
})
