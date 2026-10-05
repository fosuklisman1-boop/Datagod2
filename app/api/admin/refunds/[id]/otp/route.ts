import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, badRequest, isUuid, loadStoredRefund, refundDb, refundErrorResponse, settledStatus } from "@/lib/refunds/http"
import { defaultDeps, submitRefundOtp } from "@/lib/refunds/service"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    if (!isUuid(id)) return badRequest("Invalid refund id")
    const body = await request.json().catch(() => null)
    if (typeof body?.otp !== "string" || body.otp.length > 20) return badRequest("Invalid otp")
    const db = refundDb()
    const stored = await loadStoredRefund(db, id)
    const result = await submitRefundOtp(defaultDeps(db), stored, body.otp)
    // Never log the OTP itself, only that one was submitted.
    await auditRefund(db, userId, "order_refund_otp", { refundId: id, otpSubmitted: true, ...result })
    return NextResponse.json({ refundId: id, ...result }, { status: settledStatus(result.status) })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
