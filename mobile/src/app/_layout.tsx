import { Stack, useRouter, useSegments } from "expo-router"
import { useEffect, useRef } from "react"
import { StatusBar } from "expo-status-bar"
import { View, ActivityIndicator } from "react-native"
import * as Notifications from "expo-notifications"
import { useSession } from "@/hooks/use-session"
import { registerForPush, routeForNotification } from "@/lib/push"
import { colors } from "@/lib/theme"

export default function RootLayout() {
  const { session, loading } = useSession()
  const segments = useSegments()
  const router = useRouter()
  const booted = useRef(false)

  // Auth gate: unauthenticated users only see /login; authenticated users
  // are kept out of /login. On cold start with a session, always begin at
  // Home — dev-mode state restoration otherwise reopens the last visited
  // route (e.g. the Data tab), which is confusing.
  useEffect(() => {
    if (loading) return
    const onLogin = segments[0] === "login"
    if (!session && !onLogin) {
      router.replace("/login")
    } else if (session && onLogin) {
      router.replace("/")
    } else if (session && !booted.current) {
      const seg1 = segments[1] as string | undefined
      const atHome = segments[0] === "(tabs)" && (!seg1 || seg1 === "index")
      if (!atHome) router.replace("/")
    }
    booted.current = true
  }, [session, loading, segments])

  // Register this device for push once a session exists. Silent no-op in
  // Expo Go / on denied permission (see lib/push.ts).
  useEffect(() => {
    if (session) registerForPush()
  }, [session])

  // Tapping a push notification deep-links to the relevant screen.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>
      router.push(routeForNotification(data) as any)
    })
    return () => sub.remove()
  }, [router])

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    )
  }

  return (
    <>
      {/* Light status-bar icons sit on the purple gradient headers. */}
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="login" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="withdraw" />
        <Stack.Screen name="withdrawals" />
        <Stack.Screen name="web" />
      </Stack>
    </>
  )
}
