import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { parseAdminPeriod } from "@/lib/leaderboard/periods"
import { ensurePeriod, leaderboardErrorJson } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

/** POST { kind, anchor, rewards_enabled } turns prizes on or off for one open period. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const query = parseAdminPeriod(body?.kind, body?.anchor, new Date())
  if (!query) return NextResponse.json({ error: "Invalid period" }, { status: 400 })
  if (typeof body?.rewards_enabled !== "boolean") return NextResponse.json({ error: "rewards_enabled must be true or false" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const period = await ensurePeriod(db, query.kind, query.range)
    const { data, error } = await db.from("leaderboard_periods")
      .update({ rewards_enabled: body.rewards_enabled, updated_at: new Date().toISOString() })
      .eq("id", period.id).eq("status", "open")
      .select("id, kind, starts_on, ends_on, rewards_enabled, status, closed_at")
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: "This period is closed. Its prizes can no longer change." }, { status: 409 })

    auditLog(db, {
      adminId: auth.userId,
      action: "leaderboard_period_rewards",
      oldValue: { period_id: period.id, rewards_enabled: period.rewards_enabled },
      newValue: { period_id: period.id, rewards_enabled: body.rewards_enabled },
    })
    return NextResponse.json({ success: true, data: { row: data[0] } })
  } catch (e) {
    return leaderboardErrorJson(e, "period")
  }
}
