import { NextRequest, NextResponse } from "next/server"
import { fetchLedgerByOrders, releaseStuckClaimRow } from "@/lib/bills/admin"
import { executeBillDispatch, type BillDispatchDeps, type DispatchOrder } from "@/lib/bills/admin-dispatch"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { dispatchBillOrder } from "@/lib/bills/service"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const adminId = auth.userId
  if (!adminId) return NextResponse.json({ error: "A signed-in admin is required to dispatch" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.orderId !== "string" || !UUID.test(body.orderId)) return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  try {
    const { deps, db } = getBillsRuntime()
    const d: BillDispatchDeps = {
      async getOrder(id) { return (await deps.getOrder(id)) as unknown as DispatchOrder | null },
      async getLedger(id) { return (await fetchLedgerByOrders(db, [id])).get(id) ?? [] },
      async releaseStuckClaim(id) {
        return releaseStuckClaimRow(db, id, adminId)
      },
      async restoreProcessing(id, ref) {
        return deps.updateOrder(id, { status: "processing", notes: "Dispatch aborted: a Hubtel transaction exists. Do not resend.", ...(ref ? { hubtel_client_reference: ref } : {}) }, ["pending"])
      },
      async dispatch(order) {
        // Always dispatch a freshly read row (the service re-reads again and claims atomically).
        const fresh = await deps.getOrder(order.id)
        if (!fresh) return order.status
        auditLog(db, { adminId, action: "utility_bills_dispatch_intent", newValue: { orderId: fresh.id, reference: fresh.reference_code } })
        return dispatchBillOrder(deps, fresh)
      },
      alert: deps.alert,
      now: Date.now,
    }
    const out = await executeBillDispatch(d, body.orderId)
    const fresh = await deps.getOrder(body.orderId).catch(() => null)
    auditLog(db, {
      adminId, action: "utility_bills_dispatch",
      newValue: { orderId: body.orderId, ok: out.ok, released: out.released ?? false, status: out.orderStatus ?? null, message: out.message },
    })
    const notSent = out.orderStatus === "pending" && (fresh?.notes ?? "").startsWith("Not sent")
    return NextResponse.json({ ok: out.ok, status: out.orderStatus ?? null, order: fresh, message: notSent ? `Not sent: ${fresh?.notes}` : out.message }, { status: out.status })
  } catch (e) {
    return errorJson(e)
  }
}
