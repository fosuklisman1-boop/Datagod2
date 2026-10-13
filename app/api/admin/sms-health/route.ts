import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  normalizeSenderHealthRows,
  sortSenderHealth,
  withHealthStatus,
  type SenderHealthRowWithStatus,
} from "@/lib/sms/sender-health"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function maskPhone(p?: string | null): string {
  if (!p) return ""
  const d = String(p).replace(/\D/g, "")
  if (d.length < 5) return "***"
  return d.slice(0, 3) + "****" + d.slice(-2)
}

/**
 * GET /api/admin/sms-health?hours=24
 * Aggregated SMS deliverability for the admin panel: overall counts, per message
 * type, per provider, and recent failures (phones masked). Backed by the
 * sms_health() RPC (migrations/sms_health_panel.sql).
 *
 * Also returns `sender_health` (per sender name, Hubtel only, with a computed `status`) from the
 * sms_sender_health() RPC (migrations/20261023_sms_sender_health.sql). If that RPC is missing or
 * errors, `sender_health` is null and `sender_health_error` explains why; the rest still loads.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const hoursParam = parseInt(new URL(request.url).searchParams.get("hours") || "24", 10)
  const hours = [24, 72, 168].includes(hoursParam) ? hoursParam : 24

  try {
    const { data, error } = await supabase.rpc("sms_health", { p_hours: hours })
    if (error) {
      // Migration not applied yet → tell the admin instead of 500-ing.
      console.error("[SMS-HEALTH] RPC error:", error.message)
      return NextResponse.json(
        { error: "SMS health not available. Apply migrations/sms_health_panel.sql.", detail: error.message },
        { status: 503 }
      )
    }

    const payload = (data as any) || {}
    if (Array.isArray(payload.recent_failures)) {
      payload.recent_failures = payload.recent_failures.map((f: any) => ({
        ...f,
        phone_number: maskPhone(f.phone_number),
      }))
    }

    // OTP auto-failover breaker state (set by the delivery-sync cron).
    let otpBreaker: { open: boolean; until: string | null } = { open: false, until: null }
    try {
      const { data: b } = await supabase.from("admin_settings").select("value").eq("key", "sms_otp_breaker").maybeSingle()
      const v: any = (b as any)?.value
      otpBreaker = { open: v?.open === true && !!v?.until && new Date(v.until) > new Date(), until: v?.until ?? null }
    } catch { /* ignore */ }

    // Sender ID health (Hubtel DLR per sender name). Optional: a missing/failed RPC must never
    // take down the rest of the health page.
    let senderHealth: SenderHealthRowWithStatus[] | null = null
    let senderHealthError: string | undefined
    try {
      const { data: sh, error: shErr } = await supabase.rpc("sms_sender_health", { p_hours: hours })
      if (shErr) {
        console.error("[SMS-HEALTH] sender health RPC error:", shErr.message)
        senderHealthError = `Sender ID health not available (apply migrations/20261023_sms_sender_health.sql): ${shErr.message}`
      } else {
        senderHealth = sortSenderHealth(withHealthStatus(normalizeSenderHealthRows(sh)))
      }
    } catch (e) {
      console.error("[SMS-HEALTH] sender health error:", e)
      senderHealthError = `Sender ID health failed: ${e instanceof Error ? e.message : String(e)}`
    }

    return NextResponse.json(
      {
        success: true,
        otp_breaker: otpBreaker,
        ...payload,
        sender_health: senderHealth,
        ...(senderHealthError ? { sender_health_error: senderHealthError } : {}),
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    console.error("[SMS-HEALTH] Error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
