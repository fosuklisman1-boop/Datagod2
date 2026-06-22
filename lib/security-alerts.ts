import { createClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import { sendEmail } from "@/lib/email-service"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"

/**
 * Delivery for DB-level security alerts (see migrations 0083-0085).
 *
 * A Postgres trigger writes a `security_alerts` row and fires pg_net at
 * /api/internal/security-alert (real-time). A Vercel cron also drains any row
 * whose notified_at is still NULL (fallback). Both call deliverSecurityAlert(),
 * which atomically CLAIMS the alert (so it is sent at most once) and fans it out
 * to admins by severity.
 */

const SEVERITY_CHANNELS: Record<string, string[]> = {
  critical: ["sms", "whatsapp", "email", "inapp"],
  high: ["whatsapp", "email", "inapp"],
  info: ["email", "inapp"],
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/** Normalize a local Ghana number (0XXXXXXXXX) to WhatsApp/E.164 digits (233XXXXXXXXX). */
function toWhatsApp(local: string): string {
  let p = (local || "").replace(/\D/g, "")
  if (p.startsWith("233")) return p
  if (p.startsWith("0")) return "233" + p.slice(1)
  if (p.length === 9) return "233" + p
  return p
}

export interface DeliverResult {
  ok: boolean
  skipped?: boolean
  channels?: string[]
  reason?: string
}

/**
 * Claim + deliver one alert. Idempotent: the first caller to flip notified_at
 * wins; everyone else short-circuits, so pg_net and the cron never double-send.
 */
export async function deliverSecurityAlert(alertId: string): Promise<DeliverResult> {
  const supabase = serviceClient()

  // Atomic claim: only the caller that flips notified_at from NULL proceeds.
  const { data: alert, error } = await supabase
    .from("security_alerts")
    .update({ notified_at: new Date().toISOString() })
    .eq("id", alertId)
    .is("notified_at", null)
    .select("*")
    .maybeSingle()

  if (error) return { ok: false, reason: error.message }
  if (!alert) return { ok: true, skipped: true, reason: "not found or already notified" }

  const severity = String(alert.severity || "info")
  const channels = SEVERITY_CHANNELS[severity] || ["inapp"]
  const sent: string[] = []

  const { data: admins } = await supabase
    .from("users")
    .select("id, email, phone_number")
    .eq("role", "admin")
  const adminList = (admins || []) as Array<{ id: string; email: string | null; phone_number: string | null }>

  const emoji = severity === "critical" ? "🚨" : severity === "high" ? "⚠️" : "ℹ️"
  const subject = `${emoji} [${severity.toUpperCase()}] ${alert.title}`
  const shortMsg = `DATAGOD SECURITY ${severity.toUpperCase()}: ${alert.title}`.slice(0, 300)

  // In-app: one global admin notification (matches the existing fraud_alert pattern).
  if (channels.includes("inapp")) {
    try {
      await supabase.from("notifications").insert([{
        user_id: null,
        title: subject.slice(0, 120),
        message: alert.title,
        type: "security_alert",
        metadata: { alert_id: alert.id, severity, category: alert.category, detail: alert.detail },
        is_read: false,
        created_at: new Date().toISOString(),
      }])
      sent.push("inapp")
    } catch { /* best-effort */ }
  }

  // Email: single message to all admin addresses.
  if (channels.includes("email")) {
    const recipients = adminList.filter((a) => a.email).map((a) => ({ email: a.email as string }))
    if (recipients.length) {
      try {
        const html =
          `<h2>${emoji} ${severity.toUpperCase()} security alert</h2>` +
          `<p style="font-size:16px"><b>${alert.title}</b></p>` +
          `<p>Category: <code>${alert.category}</code><br/>Source: ${alert.source}<br/>When: ${alert.created_at}</p>` +
          `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto">${JSON.stringify(alert.detail, null, 2)}</pre>` +
          `<p style="color:#888;font-size:12px">DATAGOD automated security monitoring</p>`
        const r = await sendEmail({ to: recipients, subject, htmlContent: html, type: "security_alert" })
        if (r.success) sent.push("email")
      } catch { /* best-effort */ }
    }
  }

  // SMS: critical only (guaranteed channel).
  if (channels.includes("sms")) {
    let any = false
    for (const a of adminList) {
      if (!a.phone_number) continue
      try { await sendSMS({ phone: a.phone_number, message: shortMsg, type: "alert" }); any = true } catch { /* best-effort */ }
    }
    if (any) sent.push("sms")
  }

  // WhatsApp: best-effort. Plain text only delivers inside the 24h window; cold
  // numbers need an approved template, so this is supplementary, not relied upon.
  if (channels.includes("whatsapp")) {
    let any = false
    for (const a of adminList) {
      if (!a.phone_number) continue
      try { const id = await sendWhatsAppText(toWhatsApp(a.phone_number), shortMsg); if (id) any = true } catch { /* best-effort */ }
    }
    if (any) sent.push("whatsapp")
  }

  await supabase.from("security_alerts").update({ channels_sent: sent }).eq("id", alert.id)

  return { ok: true, channels: sent }
}

/** Drain any alerts older than `minAgeSeconds` that pg_net failed to deliver. */
export async function drainPendingAlerts(minAgeSeconds = 60): Promise<{ drained: number }> {
  const supabase = serviceClient()
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString()
  const { data } = await supabase
    .from("security_alerts")
    .select("id")
    .is("notified_at", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(50)
  const ids = (data || []).map((r: { id: string }) => r.id)
  let drained = 0
  for (const id of ids) {
    const res = await deliverSecurityAlert(id)
    if (res.ok && !res.skipped) drained++
  }
  return { drained }
}
