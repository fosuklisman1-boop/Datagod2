import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, badRequest, isUuid, loadStoredRefund, refundDb, refundErrorResponse, settledStatus } from "@/lib/refunds/http"
import { cancelRefund, defaultDeps } from "@/lib/refunds/service"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    if (!isUuid(id)) return badRequest("Invalid refund id")
    const db = refundDb()
    const stored = await loadStoredRefund(db, id)
    const result = await cancelRefund(defaultDeps(db), stored)
    await auditRefund(db, userId, "order_refund_cancel", { refundId: id, ...result })
    return NextResponse.json({ refundId: id, ...result }, { status: settledStatus(result.status) })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
