import { NextRequest, NextResponse } from "next/server"
import { retryAirtimeViaHubtel, type AirtimeRetryOrder } from "@/lib/airtime-hubtel"
import { executeBillRetry, type BillRetryDeps, type DispatchOrder } from "@/lib/bills/admin-dispatch"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { dispatchBillOrder } from "@/lib/bills/service"
import { notifyAdmins } from "@/lib/sms-service"
import { auditLog, errorJson, isValidRef, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { fetchOrderLedger, ledgerRetryCheck } from "@/lib/hubtel-cs/retry"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { dispatchBundleOrder } from "@/lib/standard-bundles/service"

export const dynamic = "force-dynamic"
export const maxDuration = 30

type Out = { ok: boolean; status: number; message: string; orderStatus?: string }

/**
 * Re-send the order behind a failed Hubtel transaction as a NEW Hubtel transaction (new client reference).
 * Gate: lib/hubtel-cs/retry.ts ledgerRetryCheck, then the product's own retry executor (order-level checks + claim).
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const adminId = auth.userId
  if (!adminId) return NextResponse.json({ error: "A signed-in admin is required to retry" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (!isValidRef(body?.ref)) return NextResponse.json({ error: "A valid ref is required" }, { status: 400 })
  const ref: string = body.ref
  try {
    const rt = getHubtelCsRuntime()
    const tx = await rt.store.getByRef(ref)
    if (!tx) return NextResponse.json({ ok: false, message: "Unknown reference" }, { status: 404 })
    let ledger
    try { ledger = await fetchOrderLedger(rt.db, tx.order_table ?? "", tx.order_id ?? "") } catch {
      return NextResponse.json({ ok: false, message: "Could not read the Hubtel ledger; try again" }, { status: 503 })
    }
    const gate = ledgerRetryCheck(tx, ledger)
    if (!gate.ok) return NextResponse.json({ ok: false, message: gate.reason }, { status: 409 })
    const orderId = tx.order_id!

    auditLog(rt.db, { adminId, action: "hubtel_cs_retry_intent", newValue: { ref, orderTable: tx.order_table, orderId } })
    let out: Out
    if (tx.order_table === "hubtel_bill_orders") {
      const { deps } = getBillsRuntime()
      const d: BillRetryDeps = {
        async getOrder(id) { return (await deps.getOrder(id)) as unknown as DispatchOrder | null },
        getLedger: id => fetchOrderLedger(rt.db, "hubtel_bill_orders", id),
        reopen: (id, note) => deps.updateOrder(id, { status: "pending", hubtel_client_reference: null, failure_reason: null, notes: `${note} (retry by admin ${adminId})` }, ["failed"]),
        revertToFailed: (id, note) => deps.updateOrder(id, { status: "failed", notes: note }, ["pending"]),
        async dispatch(order) {
          const fresh = await deps.getOrder(order.id)
          return fresh ? dispatchBillOrder(deps, fresh) : order.status
        },
        alert: deps.alert,
        now: Date.now,
      }
      out = await executeBillRetry(d, orderId)
    } else if (tx.order_table === "hubtel_data_orders") {
      const { deps } = getBundlesRuntime()
      const d: BillRetryDeps = {
        async getOrder(id) { return (await deps.getOrder(id)) as unknown as DispatchOrder | null },
        getLedger: id => fetchOrderLedger(rt.db, "hubtel_data_orders", id),
        // Paid-only guard: a storefront refund in flight changes the order first, so this write then matches nothing.
        reopen: (id, note) => deps.updateOrder(id, { status: "pending", hubtel_client_reference: null, failure_reason: null, notes: `${note} (retry by admin ${adminId})` }, ["failed"], "paid"),
        revertToFailed: (id, note) => deps.updateOrder(id, { status: "failed", notes: note }, ["pending"], "paid"),
        async dispatch(order) {
          const fresh = await deps.getOrder(order.id)
          return fresh ? dispatchBundleOrder(deps, fresh) : order.status
        },
        alert: deps.alert,
        now: Date.now,
      }
      out = await executeBillRetry(d, orderId, "standard bundle order")
    } else {
      out = await retryAirtimeViaHubtel({
        async getOrder(id) {
          const { data, error } = await rt.db.from("airtime_orders")
            .select("id, reference_code, network, beneficiary_phone, airtime_amount, status, payment_status, notes").eq("id", id).maybeSingle()
          if (error) throw error
          return data ? ({ ...data, airtime_amount: Number(data.airtime_amount) } as AirtimeRetryOrder) : null
        },
        async markOrder(id, patch, onlyFromStatuses) {
          const { data, error } = await rt.db.from("airtime_orders")
            .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).in("status", onlyFromStatuses).select("id")
          if (error) throw error
          return data?.length ?? 0
        },
        purchase: input => rt.client.purchase(input),
        refreshTx: r => rt.store.getByRef(r),
        settle: t => rt.onTransition(t),
        alert: async (message, kind) => {
          await notifyAdmins(message, kind === "review" ? "airtime_hubtel_review" : "airtime_manual_needed", orderId, true)
        },
      }, orderId, ref)
    }

    auditLog(rt.db, { adminId, action: "hubtel_cs_retry", newValue: { ref, orderTable: tx.order_table, orderId, ok: out.ok, orderStatus: out.orderStatus ?? null, message: out.message } })
    return NextResponse.json({ ok: out.ok, message: out.message, orderStatus: out.orderStatus ?? null }, { status: out.status })
  } catch (e) {
    return errorJson(e)
  }
}
