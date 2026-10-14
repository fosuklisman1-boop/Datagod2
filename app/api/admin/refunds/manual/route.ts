import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin, validateNote } from "@/lib/hubtel-cs/admin-route"
import { badRequest, isUuid, refundDb, refundErrorResponse, requireAdminUser } from "@/lib/refunds/http"
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

    const result = await executeManualRefund(defaultDeps(db), { table, orderId, note: note.note, adminId: auth.userId! })
    auditLog(db, {
      adminId: auth.userId,
      action: result.alreadyRefunded ? "order_refund_manual_noop" : "order_refund_manual",
      newValue: { table, orderId, note: note.note, refundId: result.refundId, alreadyRefunded: result.alreadyRefunded },
    })
    return NextResponse.json(result)
  } catch (err) {
    auditLog(db, {
      adminId: auth.userId,
      action: "order_refund_manual_error",
      newValue: { table: body.table ?? null, orderId: body.orderId ?? null, error: err instanceof Error ? err.message : String(err) },
    })
    return refundErrorResponse(err)
  }
}
