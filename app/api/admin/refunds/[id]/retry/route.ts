import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, badRequest, isUuid, loadStoredRefund, parseAmount, parseGateway, refundDb, refundErrorResponse, settledStatus } from "@/lib/refunds/http"
import { defaultDeps, executeRefund, RefundError } from "@/lib/refunds/service"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    if (!isUuid(id)) return badRequest("Invalid refund id")
    const body = (await request.json().catch(() => ({}))) ?? {}
    const db = refundDb()
    const prev = await loadStoredRefund(db, id)
    if (prev.status !== "failed") throw new RefundError("NOT_ELIGIBLE", "Only failed refunds can be retried")

    let gateway: string = prev.gateway
    if (body.gateway !== undefined) {
      const g = parseGateway(body.gateway)
      if (!g) return badRequest("Invalid gateway")
      gateway = g
    }
    let amount = Number(prev.amount)
    if (body.amount !== undefined) {
      const a = parseAmount(body.amount)
      if (a === null) return badRequest("Invalid amount")
      amount = a
    }

    // A retry is a brand-new reserve: eligibility, balances and the gateway are all re-checked.
    const result = await executeRefund(defaultDeps(db), {
      table: prev.order_table, orderId: prev.order_id, gateway, amount, adminId: userId ?? null,
    })
    await auditRefund(db, userId, "order_refund_retry", { previousRefundId: id, table: prev.order_table, orderId: prev.order_id, gateway, amount, ...result })
    return NextResponse.json(result, { status: settledStatus(result.status) })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
