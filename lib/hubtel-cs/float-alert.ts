import type { SupabaseClient } from "@supabase/supabase-js"

export const FLOAT_ALERT_DEBOUNCE_MS = 3_600_000
/** Distinct type so admins muting generic "balance_alert" noise cannot silence this critical alert. */
export const FLOAT_ALERT_SMS_TYPE = "hubtel_cs_float_alert"

export function shouldSendAlert(lastIso: string | null | undefined, now: Date, windowMs = FLOAT_ALERT_DEBOUNCE_MS): boolean {
  if (!lastIso) return true
  const last = Date.parse(lastIso)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= windowMs
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

export interface AlertSenders {
  sms(message: string): Promise<void>
  email(subject: string, html: string): Promise<void>
}

const realSenders: AlertSenders = {
  async sms(message) {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, FLOAT_ALERT_SMS_TYPE, "hubtel_cs_float", true)
  },
  async email(subject, html) {
    const { notifyAdmins } = await import("@/lib/email-service")
    await notifyAdmins(subject, html)
  },
}

/**
 * SMS + email to admins via the same notifyAdmins() path as the MTN balance alert; debounced per kind.
 * The debounce stamp is written before sending (best-effort guard against concurrent runs, not atomic) and
 * restored if neither channel delivered, so a failed send never mutes the next attempt. `force` bypasses the
 * debounce. Never throws.
 */
export async function sendFloatAlert(
  db: SupabaseClient, kind: "paused" | "low_balance" | "needs_review", subject: string, message: string,
  opts: { force?: boolean; senders?: AlertSenders; now?: () => Date; windowMs?: number } = {},
): Promise<void> {
  try {
    const senders = opts.senders ?? realSenders
    const key = `last_hubtel_cs_alert_${kind}`
    const { data } = await db.from("admin_settings").select("value").eq("key", key).maybeSingle()
    const now = (opts.now ?? (() => new Date()))()
    const prev = data?.value ?? null
    if (!opts.force && !shouldSendAlert(prev?.timestamp, now, opts.windowMs)) return
    const { error: stampErr } = (await db.from("admin_settings").upsert({ key, value: { timestamp: now.toISOString() }, description: "Hubtel Commission Services alert debounce", updated_at: now.toISOString() }, { onConflict: "key" })) ?? {}
    if (stampErr) console.error("[hubtel-cs] alert debounce stamp failed:", stampErr.message ?? stampErr)

    let delivered = false
    try { await senders.sms(`HUBTEL ALERT\n\n${subject}\n${message}`); delivered = true } catch (e: any) { console.error("[hubtel-cs] alert SMS error:", e?.message ?? e) }
    const html = `<div><h2 style="color:#dc2626">${escapeHtml(subject)}</h2><p>${escapeHtml(message)}</p></div>`
    try { await senders.email(subject, html); delivered = true } catch (e: any) { console.error("[hubtel-cs] alert email error:", e?.message ?? e) }

    if (!delivered && !stampErr) {
      // Nothing went out: put the previous stamp back so the next trigger can retry immediately.
      if (prev) await db.from("admin_settings").upsert({ key, value: prev, description: "Hubtel Commission Services alert debounce", updated_at: now.toISOString() }, { onConflict: "key" })
      else await db.from("admin_settings").delete().eq("key", key)
    }
  } catch (e: any) {
    console.error("[hubtel-cs] float alert failed:", e?.message ?? e)
  }
}
