import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { deliverPrize } from "@/lib/leaderboard/delivery"
import { buildDeliveryDeps } from "@/lib/leaderboard/delivery-runtime"
import { leaderboardErrorJson } from "@/lib/leaderboard/admin"
import { periodLabel } from "@/lib/leaderboard/periods"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST { result_id, phone? } sends one winner's prize (cash, data, airtime or
 * dealer upgrade). `phone` overrides the winner's number for data and airtime.
 * Safe to retry: the 0137 RPCs refuse a second send while one is in flight or
 * after delivery, and cash credits are idempotent.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (typeof body?.result_id !== "string" || !UUID.test(body.result_id)) return NextResponse.json({ error: "Invalid winner" }, { status: 400 })
  if (body.phone != null && (typeof body.phone !== "string" || body.phone.length > 20)) return NextResponse.json({ error: "Invalid phone number" }, { status: 400 })

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  try {
    const { data: result, error } = await db.from("leaderboard_results")
      .select("id, period:leaderboard_periods(kind, starts_on, ends_on)").eq("id", body.result_id).maybeSingle()
    if (error) throw error
    if (!result) return NextResponse.json({ error: "Winner not found" }, { status: 404 })
    const period = (Array.isArray(result.period) ? result.period[0] : result.period) as { kind: string; starts_on: string; ends_on: string }
    const label = period.kind === "custom"
      ? `${period.starts_on} – ${period.ends_on}`
      : periodLabel(period.kind as "daily" | "weekly" | "monthly" | "yearly", { start: period.starts_on, end: period.ends_on })

    const outcome = await deliverPrize(buildDeliveryDeps(db, auth.userId), { resultId: body.result_id, phone: body.phone, periodLabel: label })
    auditLog(db, { adminId: auth.userId, action: "leaderboard_prize_delivery", newValue: { result_id: body.result_id, ...outcome } })
    if (!outcome.ok) return NextResponse.json({ error: outcome.message }, { status: 422 })
    return NextResponse.json({ success: true, data: outcome })
  } catch (e) {
    return leaderboardErrorJson(e, "deliver")
  }
}
