import { useCallback, useState } from "react"
import {
  FlatList, Text, View, TouchableOpacity, StyleSheet, RefreshControl, Alert,
} from "react-native"
import { useFocusEffect } from "expo-router"
import { Ionicons } from "@expo/vector-icons"
import { Screen, Card, Muted } from "@/components/ui"
import {
  listNotifications, markRead, markAllRead, removeNotification,
  timeAgo, notificationIcon, type AppNotification,
} from "@/lib/notifications"
import { colors, radius } from "@/lib/theme"

export default function NotificationsScreen() {
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
    <Screen
      title="Notifications"
      back
      right={
        <TouchableOpacity onPress={onMarkAll} hitSlop={8}>
          <Text style={s.markAll}>Mark all read</Text>
        </TouchableOpacity>
      }
    >
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
              <View style={s.iconCircle}>
                <Ionicons name={notificationIcon(item.type) as any} size={18} color={colors.primary} />
              </View>
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
    </Screen>
  )
}

const s = StyleSheet.create({
  markAll: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  error: { color: colors.danger, marginBottom: 12, textAlign: "center" },
  row: { flexDirection: "row", gap: 12 },
  unread: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  iconCircle: {
    width: 38, height: 38, borderRadius: radius.full,
    backgroundColor: `${colors.primary}14`, alignItems: "center", justifyContent: "center",
    marginTop: 2,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  itemTitle: { color: colors.text, fontWeight: "600", flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.primary },
  message: { color: colors.textMuted, fontSize: 13, marginVertical: 3, lineHeight: 18 },
})
