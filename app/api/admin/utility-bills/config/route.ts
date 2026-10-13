import { NextRequest, NextResponse } from "next/server"
import { BILLER_KEYS, BILLERS } from "@/lib/bills/billers"
import { getBillsConfig, setBillsConfig, validateBillsPatch } from "@/lib/bills/config"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const dynamic = "force-dynamic"

const billerList = () => BILLER_KEYS.map(k => BILLERS[k])

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  try {
    const { db } = getHubtelCsRuntime()
    return NextResponse.json({ config: await getBillsConfig(db), billers: billerList() })
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
  const v = validateBillsPatch(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  try {
    const { db } = getHubtelCsRuntime()
    const before = await getBillsConfig(db).catch(() => null)
    const config = await setBillsConfig(db, v.patch)
    auditLog(db, { adminId: auth.userId, action: "utility_bills_config", oldValue: before, newValue: config })
    return NextResponse.json({ config, billers: billerList() })
  } catch (e) {
    return errorJson(e)
  }
}
