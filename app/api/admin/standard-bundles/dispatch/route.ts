import { NextRequest, NextResponse } from "next/server"
import { fetchBundleLedgerByOrders, releaseStuckClaimRow } from "@/lib/standard-bundles/admin"
import { executeBundleDispatch, type BundleDispatchDeps, type BundleDispatchOrder } from "@/lib/standard-bundles/admin-dispatch"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { dispatchBundleOrder } from "@/lib/standard-bundles/service"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Send a paid standard bundle order that never reached Hubtel (no Hubtel transaction of any state exists). */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const adminId = auth.userId
  if (!adminId) return NextResponse.json({ error: "A signed-in admin is required to dispatch" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.orderId !== "string" || !UUID.test(body.orderId)) return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  try {
    const { deps, db } = getBundlesRuntime()
    const d: BundleDispatchDeps = {
      async getOrder(id) { return (await deps.getOrder(id)) as unknown as BundleDispatchOrder | null },
      async getLedger(id) { return (await fetchBundleLedgerByOrders(db, [id])).get(id) ?? [] },
      async releaseStuckClaim(id) { return releaseStuckClaimRow(db, id, adminId) },
      async restoreProcessing(id, ref) {
        return deps.updateOrder(id, { status: "processing", notes: "Dispatch aborted: a Hubtel transaction exists. Do not resend.", ...(ref ? { hubtel_client_reference: ref } : {}) }, ["pending"])
      },
      async dispatch(order) {
        // Always dispatch a freshly read row (the service re-reads again and claims atomically).
        const fresh = await deps.getOrder(order.id)
        if (!fresh) return order.status
        auditLog(db, { adminId, action: "standard_bundles_dispatch_intent", newValue: { orderId: fresh.id, reference: fresh.reference_code } })
        return dispatchBundleOrder(deps, fresh)
      },
      alert: deps.alert,
      now: Date.now,
    }
    const out = await executeBundleDispatch(d, body.orderId)
    const row = await deps.getOrder(body.orderId).catch(() => null)
    // Never return idempotency_key (the orders list never selects it either).
    const fresh = row ? (({ idempotency_key: _omit, ...safe }) => safe)(row) : null
    auditLog(db, {
      adminId, action: "standard_bundles_dispatch",
      newValue: { orderId: body.orderId, ok: out.ok, released: out.released ?? false, status: out.orderStatus ?? null, message: out.message },
    })
    const notSent = out.orderStatus === "pending" && (fresh?.notes ?? "").startsWith("Not sent")
    return NextResponse.json({ ok: out.ok, status: out.orderStatus ?? null, order: fresh, message: notSent ? `Not sent: ${fresh?.notes}` : out.message }, { status: out.status })
  } catch (e) {
    return errorJson(e)
  }
}
