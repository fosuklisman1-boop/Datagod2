import { NextRequest, NextResponse } from "next/server"
import { errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

const DAY = 24 * 60 * 60 * 1000

function parseDate(v: string | null): Date | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const sp = request.nextUrl.searchParams
  const to = parseDate(sp.get("to")) ?? new Date()
  const from = parseDate(sp.get("from")) ?? new Date(to.getTime() - 7 * DAY)
  if (sp.get("from") && !parseDate(sp.get("from"))) return NextResponse.json({ error: "Invalid from date" }, { status: 400 })
  if (sp.get("to") && !parseDate(sp.get("to"))) return NextResponse.json({ error: "Invalid to date" }, { status: 400 })
  if (from > to) return NextResponse.json({ error: "from must be before to" }, { status: 400 })
  try {
    const { db } = getHubtelCsRuntime()
    const ch = sp.get("channel")
    if (ch && ch !== "all" && ch !== "dashboard" && ch !== "storefront" && ch !== "api" && ch !== "bots") return NextResponse.json({ error: "Invalid channel" }, { status: 400 })
    const args: Record<string, string> = { p_from: from.toISOString(), p_to: to.toISOString() }
    if (ch === "dashboard" || ch === "storefront" || ch === "api" || ch === "bots") args.p_channel = ch
    const { data, error } = await db.rpc("cashback_margin_report", args)
    if (error) throw error
    const rows = ((data ?? []) as Record<string, unknown>[]).map(r => ({
      service_key: String(r.service_key),
      provider: String(r.provider),
      orders: Number(r.orders ?? 0),
      face_total: Number(r.face_total ?? 0),
      actual_commission: Number(r.actual_commission ?? 0),
      cashback_total: Number(r.cashback_total ?? 0),
      shop_share_total: Number(r.shop_share_total ?? 0),
      expected_commission: Number(r.expected_commission ?? 0),
    }))
    return NextResponse.json({ from: from.toISOString(), to: to.toISOString(), rows })
  } catch (e) {
    return errorJson(e)
  }
}
