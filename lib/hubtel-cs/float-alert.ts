import type { SupabaseClient } from "@supabase/supabase-js"

export const FLOAT_ALERT_DEBOUNCE_MS = 3_600_000

export function shouldSendAlert(lastIso: string | null | undefined, now: Date, windowMs = FLOAT_ALERT_DEBOUNCE_MS): boolean {
  if (!lastIso) return true
  const last = Date.parse(lastIso)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= windowMs
}

/** SMS + email to admins via the same notifyAdmins() path as the MTN balance alert; debounced per kind. Never throws. */
export async function sendFloatAlert(db: SupabaseClient, kind: "paused" | "low_balance", subject: string, message: string): Promise<void> {
  try {
    const key = `last_hubtel_cs_alert_${kind}`
    const { data } = await db.from("admin_settings").select("value").eq("key", key).maybeSingle()
    const now = new Date()
    if (!shouldSendAlert(data?.value?.timestamp, now)) return
    // Stamp first so two concurrent runs cannot both alert.
    await db.from("admin_settings").upsert({ key, value: { timestamp: now.toISOString() }, description: "Hubtel Commission Services alert debounce", updated_at: now.toISOString() }, { onConflict: "key" })

    const { notifyAdmins: sms } = await import("@/lib/sms-service")
    await sms(`HUBTEL ALERT\n\n${subject}\n${message}`, "balance_alert", "hubtel_cs_float", true).catch(e => console.error("[hubtel-cs] alert SMS error:", e))
    const { notifyAdmins: email } = await import("@/lib/email-service")
    const html = `<div><h2 style="color:#dc2626">${subject}</h2><p>${message}</p></div>`
    await email(subject, html).catch(e => console.error("[hubtel-cs] alert email error:", e))
  } catch (e: any) {
    console.error("[hubtel-cs] float alert failed:", e?.message ?? e)
  }
}
