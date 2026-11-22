/**
 * After an admin action flips numbers to allowed, send the "ready" notices now instead of waiting for the
 * daily cron. runNotify itself enforces customer_sms_enabled, eligibility, caps and the daily ceiling and
 * claims rows before sending, so a concurrent cron run cannot double-send. Never throws.
 */
import { after } from "next/server"
import { runNotify } from "./notify"

const safeNotify = async () => {
  try {
    await runNotify()
  } catch (err) {
    console.error("[BLOCKED-ADMIN] notify-now failed:", err instanceof Error ? err.name : "UnknownError")
  }
}

/** true = scheduled (or run inline when after() is unavailable); false = the inline fallback failed. */
export async function scheduleNotifyNow(): Promise<boolean> {
  try {
    after(safeNotify)
    return true
  } catch {
    try {
      await runNotify()
      return true
    } catch (err) {
      console.error("[BLOCKED-ADMIN] notify-now fallback failed:", err instanceof Error ? err.name : "UnknownError")
      return false
    }
  }
}
