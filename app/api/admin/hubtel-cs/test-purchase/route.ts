import { NextRequest, NextResponse } from "next/server"
import { HubtelOutcomeUnknownError } from "@/lib/hubtel-cs/errors"
import { auditLog, errorJson, parseTestAmount, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { isServiceKey } from "@/lib/hubtel-cs/services"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * Admin-only LIVE smoke test (sends a real purchase to Hubtel) while product surfaces do not exist.
 * Capped at GHS 5; requires `confirm: true`; the client enforces enabled/paused/service gates and
 * validates/normalises the destination.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required for a live test purchase" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (body?.confirm !== true) return NextResponse.json({ error: "confirm: true is required: this sends a REAL purchase to Hubtel" }, { status: 400 })
  if (!isServiceKey(body?.serviceKey)) return NextResponse.json({ error: "Unknown serviceKey" }, { status: 400 })
  const a = parseTestAmount(body.amount)
  if (!a.ok) return NextResponse.json({ error: a.error }, { status: 400 })
  const amount = a.amount
  try {
    const rt = getHubtelCsRuntime()
    const config = await rt.getConfig()
    if (!config.enabled) return NextResponse.json({ error: "Hubtel Commission Services is disabled; enable it before a test purchase" }, { status: 409 })
    try {
      const tx = await rt.client.purchase({
        serviceKey: body.serviceKey, destination: String(body.destination ?? ""), amount,
        bundle: typeof body.bundle === "string" && body.bundle.length ? body.bundle : undefined,
      })
      auditLog(rt.db, { adminId: auth.userId, action: "hubtel_cs_test_purchase", newValue: { ref: tx.client_reference, serviceKey: body.serviceKey, amount } })
      return NextResponse.json({ tx })
    } catch (e) {
      if (e instanceof HubtelOutcomeUnknownError) {
        auditLog(rt.db, { adminId: auth.userId, action: "hubtel_cs_test_purchase_outcome_unknown", newValue: { ref: e.clientReference, serviceKey: body.serviceKey, amount } })
      }
      throw e
    }
  } catch (e) {
    return errorJson(e)
  }
}
