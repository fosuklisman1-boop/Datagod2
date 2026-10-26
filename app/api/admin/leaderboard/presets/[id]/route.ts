import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { leaderboardErrorJson } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** DELETE removes a preset. Prizes already set from it are unaffected (they copy its fields). */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: "Invalid preset id" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const { data, error } = await db.from("leaderboard_prize_presets").delete().eq("id", id).select("id, name")
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    auditLog(db, { adminId: auth.userId, action: "leaderboard_preset_deleted", oldValue: data[0] })
    return NextResponse.json({ success: true })
  } catch (e) {
    return leaderboardErrorJson(e, "preset delete")
  }
}
