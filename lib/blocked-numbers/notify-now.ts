/**
 * After an admin action flips numbers to allowed, send the "ready" notices now instead of waiting for the
 * daily cron. Only when the blocked-numbers master switch is on. runNotify itself enforces
 * customer_sms_enabled, eligibility, caps and the daily ceiling and claims rows before sending, so a
 * concurrent cron run cannot double-send. If after() is unavailable nothing runs inline (the cron picks the
 * rows up). Never throws.
 */
import { after } from "next/server"
import { runNotify } from "./notify"
import { getBlockedNumbersSettings } from "./settings"

const NOTIFY_WINDOW_MS = 240_000

/** true = scheduled; false = skipped (switch off, settings unreadable, or after() unavailable). */
export async function scheduleNotifyNow(opts: { startedAt: number }): Promise<boolean> {
  try {
    if ((await getBlockedNumbersSettings()).enabled !== true) return false
  } catch {
    return false
  }
  try {
    after(async () => {
      try {
        await runNotify({ deadlineAt: opts.startedAt + NOTIFY_WINDOW_MS })
      } catch (err) {
        console.error("[BLOCKED-ADMIN] notify-now failed:", err instanceof Error ? err.name : "UnknownError")
      }
    })
    return true
  } catch {
    console.error("[BLOCKED-ADMIN] notify-now not scheduled; the daily cron will send")
    return false
  }
}
