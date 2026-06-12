import { Tabs } from "expo-router"
import { Text } from "react-native"
import { colors } from "@/lib/theme"

// Emoji tab icons keep v1 dependency-free; swap for an icon set later.
function icon(emoji: string) {
  return ({ focused }: { focused: boolean }) => (
    <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.45 }}>{emoji}</Text>
  )
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border, borderTopWidth: 1 },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: icon("🏠") }} />
      <Tabs.Screen name="data" options={{ title: "Data", tabBarIcon: icon("📶") }} />
      <Tabs.Screen name="airtime" options={{ title: "Airtime", tabBarIcon: icon("📞") }} />
      <Tabs.Screen name="wallet" options={{ title: "Wallet", tabBarIcon: icon("💰") }} />
      <Tabs.Screen name="orders" options={{ title: "Orders", tabBarIcon: icon("🧾") }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: icon("👤") }} />
    </Tabs>
  )
}
