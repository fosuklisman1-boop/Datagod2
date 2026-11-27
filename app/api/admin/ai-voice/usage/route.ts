import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getNuanceUsage } from "@/lib/ai-voice/nuance"
import { nuanceKeys } from "@/lib/ai-voice/keys"

export const dynamic = "force-dynamic"
export const revalidate = 0

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)
  const since = midnight.toISOString()

  // Head counts: the database counts, no rows come back, so PostgREST's max-rows cap cannot truncate a figure.
  const counted = () =>
    supabase
      .from("ai_voice_calls")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since)
      .or("end_reason.is.null,end_reason.neq.cap_exceeded")
  const [total, visitors, dashboard, admin] = await Promise.all([
    counted(),
    counted().is("user_id", null),
    counted().eq("context", "dashboard"),
    counted().eq("context", "admin"),
  ])
  if (total.error || visitors.error || dashboard.error || admin.error) {
    return NextResponse.json({ error: "Could not load usage" }, { status: 500 })
  }
  const callsToday = {
    total: total.count ?? 0,
    visitors: visitors.count ?? 0,
    dashboard: dashboard.count ?? 0,
    admin: admin.count ?? 0,
  }

  const usage = await getNuanceUsage().catch(() => null)
  return NextResponse.json({
    callsToday,
    creditsLeft: usage?.creditsLeft ?? null,
    renewsAt: usage?.renewsAt ?? null,
    accounts: nuanceKeys().length,
  })
}
