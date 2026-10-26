import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { cancelPrize, leaderboardErrorJson } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** POST cancels a prize. It stays listed as cancelled and can never be reassigned. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid prize id" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const row = await cancelPrize(db, id, auth.userId)
    auditLog(db, { adminId: auth.userId, action: "leaderboard_prize_cancelled", newValue: { prize_id: id, period_id: row.period_id, label: row.label } })
    return NextResponse.json({ success: true, data: { prize: row } })
  } catch (e) {
    return leaderboardErrorJson(e, "prize cancel")
  }
}
