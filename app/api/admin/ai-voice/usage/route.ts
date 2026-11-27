import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getNuanceUsage } from "@/lib/ai-voice/nuance"

export const dynamic = "force-dynamic"
export const revalidate = 0

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const ROW_LIMIT = 20000

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const midnight = new Date()
  midnight.setUTCHours(0, 0, 0, 0)

  const { data, error } = await supabase
    .from("ai_voice_calls")
    .select("context,user_id")
    .gte("created_at", midnight.toISOString())
    .or("end_reason.is.null,end_reason.neq.cap_exceeded")
    .limit(ROW_LIMIT)
  if (error) return NextResponse.json({ error: "Could not load usage" }, { status: 500 })

  const rows = (data ?? []) as Array<{ context: string; user_id: string | null }>
  const callsToday = {
    total: rows.length,
    visitors: rows.filter((r) => r.user_id === null).length,
    dashboard: rows.filter((r) => r.context === "dashboard").length,
    admin: rows.filter((r) => r.context === "admin").length,
  }

  const usage = await getNuanceUsage().catch(() => null)
  return NextResponse.json({
    callsToday,
    creditsLeft: usage?.creditsLeft ?? null,
    renewsAt: usage?.renewsAt ?? null,
  })
}
