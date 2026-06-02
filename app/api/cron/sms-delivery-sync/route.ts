import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { queryMoolreDeliveryStatus, sendSMSViaFallback } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Fallback timing. OTP duplicates are harmless (same code) and speed matters, so
// fall back fast on a stuck OTP. Non-OTP messages risk a double-send if Moolre
// delivered but never returned a DLR, so those only fall back when explicitly
// enabled (SMS_FALLBACK_ON_STUCK=true), and only after a generous wait.
const OTP_STUCK_MS = 3 * 60 * 1000
const OTHER_STUCK_MS = 15 * 60 * 1000
const MAX_FALLBACK_PER_RUN = 40

/**
 * Resolve Moolre SMS delivery status + fail over undelivered messages to mNotify.
 *
 * Moolre /open/sms/query returns per-ref status: 0 Unknown, 1 Sent, 2 Delivered,
 * 3 Failed. We write the outcome back to sms_logs and, when Moolre failed to
 * deliver, RE-SEND the same message via the fallback provider (mNotify):
 *   2 -> 'delivered'
 *   3 -> resend via fallback, mark original 'failed'
 *   0/1 (stuck) -> for OTP after 3m, or non-OTP after 15m if SMS_FALLBACK_ON_STUCK:
 *                  resend via fallback, mark original 'failed'
 *   0/1 (fresh) -> leave 'sent', retry next run
 *
 * Runs every few minutes (vercel.json). Auth via CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!

  const fallbackOnStuck = process.env.SMS_FALLBACK_ON_STUCK === "true"

  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const until = new Date(Date.now() - 30 * 1000).toISOString()
    const { data: rows, error } = await supabase
      .from("sms_logs")
      .select("id, moolre_message_id, message, phone_number, message_type, created_at")
      .eq("status", "sent")
      .not("moolre_message_id", "is", null)
      .gte("created_at", since)
      .lte("created_at", until)
      .limit(500)

    if (error) {
      console.error("[CRON-SMS-DLR] Fetch error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Only our generated Moolre refs (dg-…) are queryable.
    const byRef = new Map<string, any>()
    for (const r of rows ?? []) {
      const ref = (r as any).moolre_message_id
      if (typeof ref === "string" && ref.startsWith("dg-")) byRef.set(ref, r)
    }
    const refs = Array.from(byRef.keys())
    if (refs.length === 0) return NextResponse.json({ checked: 0, delivered: 0, resent: 0, failed: 0 })

    const deliveredIds: string[] = []
    const fallbackRows: any[] = []

    const BATCH = 100
    for (let i = 0; i < refs.length; i += BATCH) {
      const statuses = await queryMoolreDeliveryStatus(refs.slice(i, i + BATCH))
      for (const [ref, status] of Object.entries(statuses)) {
        const row = byRef.get(ref)
        if (!row) continue
        if (status === 2) { deliveredIds.push(row.id); continue }

        const isOtp = row.message_type === "phone_otp"
        const ageMs = Date.now() - new Date(row.created_at).getTime()
        const stuckTooLong = isOtp ? ageMs > OTP_STUCK_MS : (fallbackOnStuck && ageMs > OTHER_STUCK_MS)

        if (status === 3 || ((status === 0 || status === 1) && stuckTooLong)) {
          fallbackRows.push(row)
        }
        // fresh 0/1 → leave as 'sent', recheck next run
      }
    }

    if (deliveredIds.length) {
      await supabase
        .from("sms_logs")
        .update({ status: "delivered", delivered_at: new Date().toISOString() })
        .in("id", deliveredIds)
    }

    // Fail over undelivered messages to the fallback provider (capped per run).
    let resent = 0
    let failed = 0
    for (const row of fallbackRows.slice(0, MAX_FALLBACK_PER_RUN)) {
      const fb = await sendSMSViaFallback({
        phone: row.phone_number,
        message: row.message,
        type: row.message_type || "sms",
      })
      await supabase
        .from("sms_logs")
        .update({
          status: "failed",
          error_message: fb.success
            ? `Moolre undelivered → resent via ${fb.provider}`
            : `Moolre undelivered; fallback failed: ${fb.error || "unknown"}`,
        })
        .eq("id", row.id)
      if (fb.success) resent++
      else failed++
    }

    // Auto-failover breaker: open/close based on recent Moolre OTP health.
    const breaker = await evaluateOtpBreaker()

    console.log(`[CRON-SMS-DLR] checked=${refs.length} delivered=${deliveredIds.length} resent=${resent} failed=${failed} otp_breaker=${breaker}`)
    return NextResponse.json({
      checked: refs.length,
      delivered: deliveredIds.length,
      resent,
      failed,
      pending_fallback: Math.max(0, fallbackRows.length - MAX_FALLBACK_PER_RUN),
      otp_breaker: breaker,
    })
  } catch (e) {
    console.error("[CRON-SMS-DLR] Error:", e)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}

/**
 * OTP auto-failover breaker. Looks at Moolre's OTP delivery outcomes over the
 * last 20 min and opens the breaker (admin_settings.sms_otp_breaker) when they're
 * failing, so sendSMS routes OTP to the fallback provider. Sticky for 30 min once
 * opened; auto-closes when Moolre's OTP traffic is healthy (or absent) again.
 * Returns "open" | "closed" | "unchanged".
 */
async function evaluateOtpBreaker(): Promise<string> {
  try {
    const evalSince = new Date(Date.now() - 20 * 60 * 1000).toISOString()
    const { data: otpRows } = await supabase
      .from("sms_logs")
      .select("status")
      .eq("message_type", "phone_otp")
      .eq("provider", "moolre")
      .in("status", ["delivered", "failed"])
      .gte("created_at", evalSince)

    const resolved = otpRows?.length ?? 0
    const failed = (otpRows ?? []).filter((r: any) => r.status === "failed").length
    // Need a minimum sample, then trip at >=50% failure.
    const unhealthy = resolved >= 3 && failed / resolved >= 0.5

    const { data: cur } = await supabase
      .from("admin_settings").select("value").eq("key", "sms_otp_breaker").maybeSingle()
    const until = (cur as any)?.value?.until ? new Date((cur as any).value.until).getTime() : 0
    const sticky = until > Date.now()

    let value: any
    let result: string
    if (unhealthy) {
      value = { open: true, until: new Date(Date.now() + 30 * 60 * 1000).toISOString(), resolved, failed, evaluated_at: new Date().toISOString() }
      result = "open"
    } else if (!sticky) {
      value = { open: false, until: null, resolved, failed, evaluated_at: new Date().toISOString() }
      result = "closed"
    } else {
      return "unchanged" // keep the sticky-open window intact
    }

    await supabase.from("admin_settings").upsert(
      { key: "sms_otp_breaker", value, description: "Auto-failover breaker: routes OTP to the fallback SMS provider while Moolre OTP delivery is failing.", updated_at: new Date().toISOString() },
      { onConflict: "key" }
    )
    if (result === "open") console.warn(`[CRON-SMS-DLR] ⚠️ OTP breaker OPEN — Moolre OTP failing (${failed}/${resolved} failed) → routing OTP to fallback`)
    return result
  } catch (e) {
    console.warn("[CRON-SMS-DLR] OTP breaker eval failed:", e)
    return "error"
  }
}
