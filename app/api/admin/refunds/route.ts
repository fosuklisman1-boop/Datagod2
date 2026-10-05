import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, badRequest, isUuid, parseAmount, parseGateway, refundDb, refundErrorResponse, settledStatus } from "@/lib/refunds/http"
import { defaultDeps, executeRefund } from "@/lib/refunds/service"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const body = await request.json().catch(() => null)
    const { table, orderId } = body ?? {}
    if (!ORDER_TABLES.includes(table as OrderTable)) return badRequest("Invalid table")
    if (!isUuid(orderId)) return badRequest("Invalid orderId")
    const gateway = parseGateway(body?.gateway)
    if (!gateway) return badRequest("Invalid gateway")
    const amount = parseAmount(body?.amount)
    if (amount === null) return badRequest("Invalid amount")

    const db = refundDb()
    const result = await executeRefund(defaultDeps(db), { table, orderId, gateway, amount, adminId: userId ?? null })
    await auditRefund(db, userId, "order_refund", { table, orderId, gateway, amount, ...result })
    return NextResponse.json(result, { status: settledStatus(result.status) })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
