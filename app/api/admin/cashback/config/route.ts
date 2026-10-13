import { NextRequest, NextResponse } from "next/server"
import { getCashbackConfig, setCashbackConfig, validateCashbackPatch } from "@/lib/cashback/config"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  try {
    const { db } = getHubtelCsRuntime()
    return NextResponse.json({ config: await getCashbackConfig(db) })
  } catch (e) {
    return errorJson(e)
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to change settings" }, { status: 403 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  try {
    const { db } = getHubtelCsRuntime()
    const before = await getCashbackConfig(db)
    const v = validateCashbackPatch(body, before)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    const config = await setCashbackConfig(db, v.patch, before)
    auditLog(db, { adminId: auth.userId, action: "cashback_config", oldValue: before, newValue: config })
    return NextResponse.json({ config })
  } catch (e) {
    return errorJson(e)
  }
}
