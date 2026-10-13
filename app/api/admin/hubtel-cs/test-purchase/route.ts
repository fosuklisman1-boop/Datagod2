import { NextRequest, NextResponse } from "next/server"
import { TEST_PURCHASE_MAX_GHS, auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { isServiceKey } from "@/lib/hubtel-cs/services"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Admin-only LIVE smoke test (sends a real purchase to Hubtel) while product surfaces do not exist.
 * Capped at GHS 5; the client enforces enabled/paused/service gates and validates/normalises the destination.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (!isServiceKey(body?.serviceKey)) return NextResponse.json({ error: "Unknown serviceKey" }, { status: 400 })
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > TEST_PURCHASE_MAX_GHS) {
    return NextResponse.json({ error: `Test amount must be between 0.01 and ${TEST_PURCHASE_MAX_GHS}` }, { status: 400 })
  }
  try {
    const rt = getHubtelCsRuntime()
    const config = await rt.getConfig()
    if (!config.enabled) return NextResponse.json({ error: "Hubtel Commission Services is disabled; enable it before a test purchase" }, { status: 409 })
    const tx = await rt.client.purchase({
      serviceKey: body.serviceKey, destination: String(body.destination ?? ""), amount,
      bundle: typeof body.bundle === "string" && body.bundle.length ? body.bundle : undefined,
    })
    auditLog(rt.db, { adminId: auth.userId, action: "hubtel_cs_test_purchase", newValue: { ref: tx.client_reference, serviceKey: body.serviceKey, amount } })
    return NextResponse.json({ tx })
  } catch (e) {
    return errorJson(e)
  }
}
