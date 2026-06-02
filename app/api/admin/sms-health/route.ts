import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

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
    return NextResponse.json({ success: true, ...payload }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    console.error("[SMS-HEALTH] Error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
