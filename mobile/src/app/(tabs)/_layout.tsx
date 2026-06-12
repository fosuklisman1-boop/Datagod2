import { useState } from "react"
import { Tabs } from "expo-router"
import { Text, View, Pressable, StyleSheet, Platform } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { LinearGradient } from "expo-linear-gradient"
import { Ionicons } from "@expo/vector-icons"
import * as Haptics from "expo-haptics"
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs"
import { SideMenu } from "@/components/side-menu"
import { colors, radius, purpleGradient } from "@/lib/theme"

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: "grid-outline",
  data: "wifi-outline",
  airtime: "call-outline",
  wallet: "wallet-outline",
  orders: "receipt-outline",
  profile: "person-outline",
}

// Floating purple pill nav, like the web dealer skin: the active tab is a
// white pill with purple icon+label; inactive tabs are white icons. Tapping
// the ACTIVE tab again opens the side menu (same gesture as the web app).
function PillTabBar({
  state, descriptors, navigation, onOpenMenu,
}: BottomTabBarProps & { onOpenMenu: () => void }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[s.wrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <LinearGradient
        colors={purpleGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={s.bar}
      >
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key]
          const label = (options.title ?? route.name) as string
          const focused = state.index === index
          const icon = TAB_ICONS[route.name] ?? "ellipse-outline"

          const onPress = () => {
            if (Platform.OS !== "web") {
              Haptics.selectionAsync().catch(() => {})
            }
            if (focused) {
              onOpenMenu()
              return
            }
            const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true })
            if (!event.defaultPrevented) {
              navigation.navigate(route.name)
            }
          }

          return focused ? (
            <Pressable key={route.key} onPress={onPress} style={s.activePill}>
              <Ionicons name={icon} size={18} color={colors.primary} />
              <Text style={s.activeLabel} numberOfLines={1}>{label}</Text>
              <Ionicons name="menu-outline" size={14} color={colors.primary} />
            </Pressable>
          ) : (
            <Pressable key={route.key} onPress={onPress} style={s.inactiveTab}>
              <Ionicons name={icon} size={20} color="rgba(255,255,255,0.92)" />
              <Text style={s.inactiveLabel} numberOfLines={1}>{label}</Text>
            </Pressable>
          )
        })}
      </LinearGradient>
    </View>
  )
}

export default function TabsLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
      <Tabs
        tabBar={(props) => <PillTabBar {...props} onOpenMenu={() => setMenuOpen(true)} />}
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.bg },
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Home" }} />
        <Tabs.Screen name="data" options={{ title: "Data" }} />
        <Tabs.Screen name="airtime" options={{ title: "Airtime" }} />
        <Tabs.Screen name="wallet" options={{ title: "Wallet" }} />
        <Tabs.Screen name="orders" options={{ title: "Orders" }} />
        <Tabs.Screen name="profile" options={{ title: "Profile" }} />
      </Tabs>
      <SideMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  )
}

const s = StyleSheet.create({
  wrap: { backgroundColor: colors.bg, paddingHorizontal: 12, paddingTop: 6 },
  bar: {
    flexDirection: "row", alignItems: "center", borderRadius: radius.full,
    paddingVertical: 8, paddingHorizontal: 8,
    shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  activePill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#ffffff", borderRadius: radius.full,
    paddingVertical: 10, paddingHorizontal: 14,
  },
  activeLabel: { color: colors.primary, fontWeight: "800", fontSize: 13 },
  inactiveTab: { flex: 1, alignItems: "center", gap: 2, paddingVertical: 6 },
  inactiveLabel: { color: "rgba(255,255,255,0.85)", fontSize: 10, fontWeight: "600" },
})
