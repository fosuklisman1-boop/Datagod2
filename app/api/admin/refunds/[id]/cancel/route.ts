import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, badRequest, isUuid, loadStoredRefund, refundDb, refundErrorResponse, requireAdminUser, auditRefundError, settledHttpStatus } from "@/lib/refunds/http"
import { cancelRefund, defaultDeps } from "@/lib/refunds/service"

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
    const stored = await loadStoredRefund(db, id)
    const result = await cancelRefund(defaultDeps(db), stored)
    await auditRefund(db, userId, "order_refund_cancel", { refundId: id, ...result })
    return NextResponse.json({ refundId: id, ...result }, { status: settledHttpStatus("cancel", result.status) })
  } catch (err) {
    await auditRefundError(db, userId, "order_refund_cancel", err, { refundId: idForAudit })
    return refundErrorResponse(err)
  }
}
