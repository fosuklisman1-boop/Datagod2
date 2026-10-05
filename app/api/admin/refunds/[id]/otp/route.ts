import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, badRequest, isUuid, loadStoredRefund, refundDb, refundErrorResponse, requireAdminUser, auditRefundError, settledHttpStatus } from "@/lib/refunds/http"
import { defaultDeps, submitRefundOtp } from "@/lib/refunds/service"

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
    const body = await request.json().catch(() => null)
    if (typeof body?.otp !== "string" || body.otp.length > 20) return badRequest("Invalid otp")
    const stored = await loadStoredRefund(db, id)
    const result = await submitRefundOtp(defaultDeps(db), stored, body.otp)
    // Never log the OTP itself, only that one was submitted.
    await auditRefund(db, userId, "order_refund_otp", { refundId: id, otpSubmitted: true, ...result })
    return NextResponse.json({ refundId: id, ...result }, { status: settledHttpStatus("otp", result.status) })
  } catch (err) {
    await auditRefundError(db, userId, "order_refund_otp", err, { refundId: idForAudit, otpSubmitted: true })
    return refundErrorResponse(err)
  }
}
