import { NextRequest, NextResponse } from "next/server"
import { canDispatch } from "@/lib/bills/admin"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { dispatchBillOrder } from "@/lib/bills/service"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to dispatch" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.orderId !== "string" || !UUID.test(body.orderId)) return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  try {
    const { deps, db } = getBillsRuntime()
    // Always dispatch a freshly read row (the service re-reads again before sending).
    const order = await deps.getOrder(body.orderId)
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 })
    if (!canDispatch(order)) {
      return NextResponse.json({ error: "Only paid, pending orders that were never sent can be dispatched" }, { status: 409 })
    }
    const status = await dispatchBillOrder(deps, order)
    const fresh = await deps.getOrder(body.orderId).catch(() => null)
    auditLog(db, { adminId: auth.userId, action: "utility_bills_dispatch", newValue: { orderId: order.id, reference: order.reference_code, status } })
    const notSent = status === "pending" && (fresh?.notes ?? "").startsWith("Not sent")
    return NextResponse.json({
      ok: status !== "pending", status, order: fresh,
      message: status === "pending"
        ? (notSent ? `Not sent: ${fresh?.notes}` : "The order is still pending; check its notes before trying again")
        : `Dispatched; order is ${status}`,
    })
  } catch (e) {
    return errorJson(e)
  }
}
