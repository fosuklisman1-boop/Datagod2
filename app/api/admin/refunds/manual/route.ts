import { NextRequest, NextResponse } from "next/server"
import { requireAdmin, validateNote } from "@/lib/hubtel-cs/admin-route"
import { auditRefund, badRequest, isUuid, refundDb, refundErrorResponse, requireAdminUser } from "@/lib/refunds/http"
import { defaultDeps, executeManualRefund } from "@/lib/refunds/service"
import { isCommissionTable } from "@/lib/refunds/types"

/** "Mark refunded manually" for a storefront commission order (airtime / bill / bundle). No money moves here. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const denied = requireAdminUser(auth.userId)
  if (denied) return denied
  const db = refundDb()
  let body: Record<string, unknown> = {}
  try {
    body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const { table, orderId } = body
    if (typeof table !== "string" || !isCommissionTable(table)) return badRequest("Invalid table")
    if (!isUuid(orderId)) return badRequest("Invalid orderId")
    const note = validateNote(body.note)
    if (!note.ok) return badRequest(note.error)
    if (body.confirmOverride !== undefined && typeof body.confirmOverride !== "boolean") return badRequest("confirmOverride must be a boolean")

    const result = await executeManualRefund(defaultDeps(db), {
      table, orderId, note: note.note, adminId: auth.userId!, confirmOverride: body.confirmOverride === true,
    })
    // Awaited: the audit row is one of the durable records of the full note.
    await auditRefund(db, auth.userId, result.alreadyRefunded ? "order_refund_manual_noop" : "order_refund_manual", {
      table, orderId, note: note.note, refundId: result.refundId, alreadyRefunded: result.alreadyRefunded,
      confirmOverride: body.confirmOverride === true,
    })
    return NextResponse.json(result)
  } catch (err) {
    await auditRefund(db, auth.userId, "order_refund_manual_error", {
      table: body.table ?? null, orderId: body.orderId ?? null, error: err instanceof Error ? err.message : String(err),
    })
    return refundErrorResponse(err)
  }
}
