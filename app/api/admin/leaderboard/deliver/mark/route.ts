import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { leaderboardErrorJson } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NOTE = 500

/** POST { result_id, note? } records a prize as delivered by hand (manual prizes, or one given another way). */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (typeof body?.result_id !== "string" || !UUID.test(body.result_id)) return NextResponse.json({ error: "Invalid winner" }, { status: 400 })
  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) : ""

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const { data, error } = await db.rpc("leaderboard_delivery_mark", { p_result_id: body.result_id, p_admin: auth.userId, p_note: note })
    if (error) throw error
    auditLog(db, { adminId: auth.userId, action: "leaderboard_prize_marked_delivered", newValue: { result_id: body.result_id, note } })
    return NextResponse.json({ success: true, data: { delivery: data } })
  } catch (e) {
    return leaderboardErrorJson(e, "mark delivered")
  }
}
