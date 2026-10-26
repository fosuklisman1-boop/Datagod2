import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { leaderboardErrorJson, setPaused } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

/** POST { paused: boolean } pauses or resumes the Top Performers program for every user. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (typeof body?.paused !== "boolean") return NextResponse.json({ error: "paused must be true or false" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const config = await setPaused(db, body.paused, auth.userId)
    auditLog(db, { adminId: auth.userId, action: body.paused ? "leaderboard_paused" : "leaderboard_resumed", newValue: config })
    return NextResponse.json({ success: true, data: { config } })
  } catch (e) {
    return leaderboardErrorJson(e, "config")
  }
}
