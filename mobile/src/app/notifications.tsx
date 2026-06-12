import { useCallback, useState } from "react"
import {
  FlatList, Text, View, TouchableOpacity, StyleSheet, RefreshControl, Alert,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useFocusEffect, useRouter } from "expo-router"
import { Card, Muted } from "@/components/ui"
import {
  listNotifications, markRead, markAllRead, removeNotification,
  timeAgo, notificationEmoji, type AppNotification,
} from "@/lib/notifications"
import { colors, radius } from "@/lib/theme"

export default function NotificationsScreen() {
  const router = useRouter()
  const [items, setItems] = useState<AppNotification[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems(await listNotifications())
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? "Failed to load notifications")
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  const onTap = async (n: AppNotification) => {
    if (!n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)))
      markRead(n.id).catch(() => {})
    }
  }

  const onLongPress = (n: AppNotification) => {
    Alert.alert("Delete notification", "Remove this notification?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setItems((prev) => prev.filter((x) => x.id !== n.id))
          removeNotification(n.id).catch(() => {})
        },
      },
    ])
  }

  const onMarkAll = () => {
    setItems((prev) => prev.map((x) => ({ ...x, read: true })))
    markAllRead().catch(() => {})
  }

  return (
    <SafeAreaView style={s.safe} edges={["top"]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Text style={s.back}>‹</Text>
        </TouchableOpacity>
        <Text style={s.title}>Notifications</Text>
        <TouchableOpacity onPress={onMarkAll} hitSlop={8}>
          <Text style={s.markAll}>Mark all read</Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={s.error}>{error}</Text> : null}

      <FlatList
        data={items}
        keyExtractor={(n) => n.id}
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
          <TouchableOpacity onPress={() => onTap(item)} onLongPress={() => onLongPress(item)}>
            <Card style={{ ...s.row, ...(item.read ? {} : s.unread) }}>
              <Text style={s.emoji}>{notificationEmoji(item.type)}</Text>
              <View style={{ flex: 1 }}>
                <View style={s.titleRow}>
                  <Text style={[s.itemTitle, !item.read && { fontWeight: "800" }]} numberOfLines={1}>
                    {item.title}
                  </Text>
                  {!item.read && <View style={s.dot} />}
                </View>
                <Text style={s.message} numberOfLines={3}>{item.message}</Text>
                <Muted>{timeAgo(item.created_at)}</Muted>
              </View>
            </Card>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Card><Muted>No notifications yet.</Muted></Card>}
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
  markAll: { color: colors.primary, fontSize: 13, fontWeight: "600" },
  error: { color: colors.danger, marginBottom: 12, textAlign: "center" },
  row: { flexDirection: "row", gap: 12 },
  unread: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  emoji: { fontSize: 22, marginTop: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  itemTitle: { color: colors.text, fontWeight: "600", flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.primary },
  message: { color: colors.textMuted, fontSize: 13, marginVertical: 3, lineHeight: 18 },
})
