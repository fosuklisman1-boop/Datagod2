import { NextRequest, NextResponse } from "next/server"
import { fetchLedgerByOrders } from "@/lib/bills/admin"
import { executeBillRetry, type BillRetryDeps, type DispatchOrder } from "@/lib/bills/admin-dispatch"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { dispatchBillOrder } from "@/lib/bills/service"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Re-send a paid bill order that Hubtel failed (a new Hubtel transaction). */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const adminId = auth.userId
  if (!adminId) return NextResponse.json({ error: "A signed-in admin is required to retry" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.orderId !== "string" || !UUID.test(body.orderId)) return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  try {
    const { deps, db } = getBillsRuntime()
    const d: BillRetryDeps = {
      async getOrder(id) { return (await deps.getOrder(id)) as unknown as DispatchOrder | null },
      async getLedger(id) { return (await fetchLedgerByOrders(db, [id])).get(id) ?? [] },
      async reopen(id, note) {
        return deps.updateOrder(id, { status: "pending", hubtel_client_reference: null, failure_reason: null, notes: `${note} (retry by admin ${adminId})` }, ["failed"])
      },
      async revertToFailed(id, note) {
        return deps.updateOrder(id, { status: "failed", notes: note }, ["pending"])
      },
      async dispatch(order) {
        const fresh = await deps.getOrder(order.id)
        if (!fresh) return order.status
        auditLog(db, { adminId, action: "utility_bills_retry_intent", newValue: { orderId: fresh.id, reference: fresh.reference_code } })
        return dispatchBillOrder(deps, fresh)
      },
      alert: deps.alert,
      now: Date.now,
    }
    const out = await executeBillRetry(d, body.orderId)
    const fresh = await deps.getOrder(body.orderId).catch(() => null)
    auditLog(db, {
      adminId, action: "utility_bills_retry",
      newValue: { orderId: body.orderId, ok: out.ok, status: out.orderStatus ?? null, message: out.message },
    })
    return NextResponse.json({ ok: out.ok, status: out.orderStatus ?? null, order: fresh, message: out.message }, { status: out.status })
  } catch (e) {
    return errorJson(e)
  }
}
