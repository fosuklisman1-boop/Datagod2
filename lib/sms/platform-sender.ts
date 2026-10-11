/**
 * The platform's own default sender name for HUBTEL sends: the admin-configured default
 * (Settings -> Platform sender names) when it is set and still in the list, else the
 * env/hardcoded name. Never throws. Moolre / mNotify / Brevo must NOT use this: they only
 * send from names registered with them, so they keep their own env-based name.
 */
import { platformSenderName } from "@/lib/sms-service"
import { loadSmsSettings } from "./platform-settings"

export async function resolvePlatformSender(): Promise<string> {
  try {
    const s = await loadSmsSettings()
    const want = s.platformDefaultSender?.trim().toUpperCase()
    if (want) {
      const hit = s.platformSenders.find((n) => n.toUpperCase() === want)
      if (hit) return hit
    }
  } catch (e) {
    console.error("[SMS-PLATFORM-SENDER] settings unavailable, using env sender:", e)
  }
  return platformSenderName()
}
