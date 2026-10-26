import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { validatePresetName, validatePrize } from "@/lib/leaderboard/prizes"
import { leaderboardErrorJson, packageName } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

/** POST { name, prize } saves a reusable prize template. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const name = validatePresetName(body?.name)
  if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    let bundleName: string | null = null
    if (body?.prize?.prize_type === "data_bundle" && typeof body.prize.package_id === "string") {
      bundleName = await packageName(db, body.prize.package_id).catch(() => null)
      if (!bundleName) return NextResponse.json({ error: "That data bundle no longer exists" }, { status: 400 })
    }
    const prize = validatePrize(body?.prize, bundleName)
    if (!prize.ok) return NextResponse.json({ error: prize.error }, { status: 400 })

    const { data, error } = await db.from("leaderboard_prize_presets")
      .insert({ name: name.value, ...prize.value, created_by: auth.userId })
      .select("id, name, prize_type, label, amount, package_id, network, role, duration_days, created_at")
      .single()
    if (error) throw error
    auditLog(db, { adminId: auth.userId, action: "leaderboard_preset_created", newValue: data })
    return NextResponse.json({ success: true, data: { preset: data } })
  } catch (e) {
    return leaderboardErrorJson(e, "preset create")
  }
}
