// Expo push registration. EVERY step degrades silently: push is unavailable in
// Expo Go (SDK 53+), permission can be denied, and the EAS projectId may not
// exist yet — none of those may ever block the UX.
import * as Notifications from "expo-notifications"
import * as Device from "expo-device"
import Constants from "expo-constants"
import { Platform } from "react-native"
import { apiFetch } from "./api"

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
})

let registeredToken: string | null = null

export async function registerForPush(): Promise<void> {
  try {
    if (Platform.OS === "web" || !Device.isDevice) return

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
      })
    }

    let { status } = await Notifications.getPermissionsAsync()
    if (status !== "granted") {
      ;({ status } = await Notifications.requestPermissionsAsync())
    }
    if (status !== "granted") return

    // No EAS projectId (e.g. Expo Go before `eas init`) → push not possible.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? (Constants as any).easConfig?.projectId
    if (!projectId) return

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
    await apiFetch("/api/push/register", {
      method: "POST",
      body: JSON.stringify({
        token,
        platform: Platform.OS,
        deviceName: Device.deviceName ?? undefined,
      }),
    })
    registeredToken = token
  } catch {
    // Expo Go, denied permission, offline — all fine, push just stays off.
  }
}

export async function unregisterPush(): Promise<void> {
  if (!registeredToken) return
  try {
    await apiFetch("/api/push/register", {
      method: "DELETE",
      body: JSON.stringify({ token: registeredToken }),
    })
  } catch {
    // Best-effort; dispatch prunes dead tokens anyway.
  }
  registeredToken = null
}

// Maps a notification's `data.type` to the in-app route to open on tap.
export function routeForNotification(data: Record<string, unknown> | undefined): string {
  switch (data?.type) {
    case "order_update":
      return "/orders"
    case "payment_success":
    case "balance_updated":
      return "/wallet"
    case "withdrawal_approved":
    case "withdrawal_rejected":
      return "/withdrawals"
    default:
      return "/notifications"
  }
}
