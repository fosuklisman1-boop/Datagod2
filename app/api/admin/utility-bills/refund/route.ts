import { NextRequest, NextResponse } from "next/server"
import { BILL_ORDERS_TABLE, fetchLedgerByOrders, releaseStuckClaimRow } from "@/lib/bills/admin"
import { executeBillRefund, type BillRefundDeps, type RefundOrder } from "@/lib/bills/admin-refund"
import { adminRefund } from "@/lib/hubtel-cs/admin-actions"
import { getOrderAdapter } from "@/lib/hubtel-cs/adapters"
import { auditLog, errorJson, requireAdmin, validateNote } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import type { HubtelCsTx } from "@/lib/hubtel-cs/types"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const adminId = auth.userId
  if (!adminId) return NextResponse.json({ error: "A signed-in admin is required to refund" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.orderId !== "string" || !UUID.test(body.orderId)) return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  const note = validateNote(body.note)
  if (!note.ok) return NextResponse.json({ error: note.error }, { status: 400 })
  if (body.force !== undefined && typeof body.force !== "boolean") return NextResponse.json({ error: "force must be a boolean" }, { status: 400 })
  const force = body.force === true
  try {
    const rt = getHubtelCsRuntime()
    const { db } = rt
    const deps: BillRefundDeps = {
      async getOrder(id) {
        const { data, error } = await db.from(BILL_ORDERS_TABLE)
          .select("id, reference_code, channel, status, payment_status, hubtel_client_reference, notes, updated_at, user_id, biller, amount, paid_amount, account_number").eq("id", id).maybeSingle()
        if (error) throw error
        return (data as unknown as RefundOrder | null) ?? null
      },
      async getLedger(orderId) { return (await fetchLedgerByOrders(db, [orderId])).get(orderId) ?? [] },
      async markFailed(orderId, text) {
        const { data, error } = await db.from(BILL_ORDERS_TABLE)
          .update({ status: "failed", failure_reason: "Never sent to Hubtel", notes: text.slice(0, 1000), updated_at: new Date().toISOString() })
          .eq("id", orderId).in("status", ["pending"]).eq("payment_status", "paid").select("id")
        if (error) throw error
        return data?.length ?? 0
      },
      async revertToProcessing(orderId, ref, from) {
        const { data, error } = await db.from(BILL_ORDERS_TABLE)
          .update({ status: "processing", failure_reason: null, ...(ref ? { hubtel_client_reference: ref } : {}), notes: "Refund aborted: a Hubtel transaction exists. Do not resend.", updated_at: new Date().toISOString() })
          .eq("id", orderId).in("status", [from]).select("id")
        if (error) throw error
        return data?.length ?? 0
      },
      async releaseStuckClaim(orderId) { return releaseStuckClaimRow(db, orderId, adminId) },
      async refundViaLedger(ref, f) {
        const out = await adminRefund(rt.adminDeps, ref, adminId, { force: f })
        return { ok: out.ok, message: out.message }
      },
      async refundDirect(order) {
        const adapter = getOrderAdapter(BILL_ORDERS_TABLE)
        if (!adapter?.refundToWallet) return { refunded: false, message: "No refund handler is registered for bill orders" }
        // The adapter only reads order_id and client_reference from the ledger row; this order has none.
        const stub = { order_id: order.id, order_table: BILL_ORDERS_TABLE, client_reference: order.reference_code } as unknown as HubtelCsTx
        return adapter.refundToWallet(stub, adminId)
      },
      async alert(message, urgent) {
        const { notifyAdmins } = await import("@/lib/sms-service")
        await notifyAdmins(message, "bills_review", undefined, !urgent)
      },
      now: Date.now,
    }
    const out = await executeBillRefund(deps, body.orderId, note.note, force)
    auditLog(db, {
      adminId, action: "utility_bills_refund",
      newValue: { orderId: body.orderId, note: note.note, force, ok: out.ok, mode: out.mode ?? null, released: out.released ?? false, message: out.message },
    })
    return NextResponse.json({ ok: out.ok, message: out.message, mode: out.mode ?? null }, { status: out.status })
  } catch (e) {
    return errorJson(e)
  }
}
