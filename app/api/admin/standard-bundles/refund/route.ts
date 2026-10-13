import { NextRequest, NextResponse } from "next/server"
import {
  DATA_ORDERS_TABLE, executeBundleRefund, fetchLedgerOrderIds, releaseStuckClaimRow, type BundleRefundDeps, type RefundOrder,
} from "@/lib/standard-bundles/admin"
import { auditLog, errorJson, requireAdmin, validateNote } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

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
  try {
    const { db } = getHubtelCsRuntime()
    const deps: BundleRefundDeps = {
      async getOrder(id) {
        const { data, error } = await db.from(DATA_ORDERS_TABLE)
          .select("id, reference_code, user_id, amount, network, bundle_display, beneficiary_phone, status, payment_status, hubtel_client_reference, notes, updated_at").eq("id", id).maybeSingle()
        if (error) throw error
        return (data as unknown as RefundOrder | null) ?? null
      },
      async ledgerCount(orderId) { return (await fetchLedgerOrderIds(db, [orderId])).has(orderId) ? 1 : 0 },
      async releaseStuckClaim(orderId) { return releaseStuckClaimRow(db, orderId, adminId) },
      async claimForRefund(orderId, text) {
        const { data, error } = await db.from(DATA_ORDERS_TABLE)
          .update({ status: "failed", failure_reason: "Never sent to Hubtel", notes: text.slice(0, 1000), updated_at: new Date().toISOString() })
          .eq("id", orderId).eq("status", "pending").eq("payment_status", "paid").select("id")
        if (error) throw error
        return data?.length ?? 0
      },
      async revertToProcessing(orderId, ref) {
        const { data, error } = await db.from(DATA_ORDERS_TABLE)
          .update({
            status: "processing", failure_reason: null, ...(ref ? { hubtel_client_reference: ref } : {}),
            notes: "Refund aborted: a Hubtel transaction exists. Do not resend.", updated_at: new Date().toISOString(),
          })
          .eq("id", orderId).eq("status", "failed").eq("payment_status", "paid").select("id")
        if (error) throw error
        return data?.length ?? 0
      },
      async ledgerRef(orderId) {
        const { data, error } = await db.from("hubtel_cs_transactions").select("client_reference")
          .eq("order_table", DATA_ORDERS_TABLE).eq("order_id", orderId).order("created_at", { ascending: false }).limit(1)
        if (error) throw error
        return (data?.[0] as any)?.client_reference ?? null
      },
      async notifyRefunded(order) {
        const title = "Standard bundle refunded"
        const message = `GHS ${Number(order.amount).toFixed(2)} for your ${order.network} ${order.bundle_display} bundle to ${order.beneficiary_phone} was refunded to your wallet.`
        try {
          const { error } = await db.from("notifications").insert({
            user_id: order.user_id, title, message, type: "order_update", reference_id: order.id, action_url: "/dashboard/standard-bundles", read: false,
          })
          if (error) console.error("[standard-bundles] refund notification insert error:", error.message)
        } catch (e: any) { console.error("[standard-bundles] refund notification error:", e?.message ?? e) }
        try {
          const { sendPushToUser } = await import("@/lib/push-service")
          await sendPushToUser(order.user_id, { title, body: message, data: { url: "/dashboard/standard-bundles" } })
        } catch (e: any) { console.error("[standard-bundles] refund push error:", e?.message ?? e) }
      },
      async creditWallet(order) {
        // Same reference as the Hubtel adapter's refundToWallet, so the two paths can never both credit.
        const { error } = await db.rpc("credit_wallet_safely", {
          p_user_id: order.user_id, p_amount: Number(order.amount), p_reference_id: `data-refund-${order.id}`,
          p_description: `Refund: ${order.network} ${order.bundle_display} bundle ${order.reference_code}`, p_source: "standard_bundle_refund",
        })
        // A unique violation means a concurrent/earlier call already credited this reference: idempotent success.
        if (error && (error as any).code !== "23505") throw error
      },
      async markRefunded(orderId) {
        const { data, error } = await db.from(DATA_ORDERS_TABLE)
          .update({ status: "refunded", payment_status: "refunded", updated_at: new Date().toISOString() })
          .eq("id", orderId).eq("status", "failed").eq("payment_status", "paid").select("id")
        if (error) throw error
        return data?.length ?? 0
      },
      async alert(message, urgent) {
        const { notifyAdmins } = await import("@/lib/sms-service")
        await notifyAdmins(message, "bills_review", undefined, !urgent)
      },
      now: Date.now,
    }
    let audit: Record<string, unknown> = { ok: false, message: "threw before completing" }
    try {
      const out = await executeBundleRefund(deps, body.orderId, note.note)
      audit = { ok: out.ok, released: out.released ?? false, message: out.message }
      return NextResponse.json({ ok: out.ok, message: out.message }, { status: out.status })
    } catch (e: any) {
      audit = { ok: false, message: `error: ${e?.message ?? e}` }
      throw e
    } finally {
      auditLog(db, { adminId, action: "standard_bundles_refund", newValue: { orderId: body.orderId, note: note.note, ...audit } })
    }
  } catch (e) {
    return errorJson(e)
  }
}
