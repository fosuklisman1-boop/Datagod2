import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, auditRefundError, badRequest, isUuid, loadStoredRefund, refundDb, refundErrorResponse, requireAdminUser } from "@/lib/refunds/http"
import { defaultDeps, markHubtelSendNeverPaid } from "@/lib/refunds/service"

/** "Hubtel confirms this never paid: mark failed". Hubtel is asked again first; see markHubtelSendNeverPaid. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const denied = requireAdminUser(userId)
  if (denied) return denied
  let idForAudit: string | undefined
  const db = refundDb()
  try {
    const { id } = await params
    idForAudit = isUuid(id) ? id : undefined
    if (!isUuid(id)) return badRequest("Invalid refund id")
    const body = (await request.json().catch(() => ({}))) ?? {}
    if (body.confirm !== true) return badRequest("This needs an explicit confirmation")
    const stored = await loadStoredRefund(db, id)
    const result = await markHubtelSendNeverPaid(defaultDeps(db), stored)
    await auditRefund(db, userId, "order_refund_hubtel_never_paid", { refundId: id, orderId: stored.order_id, ...result })
    return NextResponse.json({ refundId: id, ...result })
  } catch (err) {
    await auditRefundError(db, userId, "order_refund_hubtel_never_paid", err, { refundId: idForAudit })
    return refundErrorResponse(err)
  }
}
