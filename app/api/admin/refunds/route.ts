import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { auditRefund, badRequest, isUuid, parseAmount, parseGateway, parseManualReference, refundDb, refundErrorResponse, requireAdminUser, auditRefundError, settledHttpStatus } from "@/lib/refunds/http"
import { defaultDeps, executeRefund } from "@/lib/refunds/service"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const denied = requireAdminUser(userId)
  if (denied) return denied
  let body: unknown = null
  const db = refundDb()
  try {
    body = await request.json().catch(() => null)
    const { table, orderId } = (body ?? {}) as Record<string, unknown>
    if (!ORDER_TABLES.includes(table as OrderTable)) return badRequest("Invalid table")
    if (!isUuid(orderId)) return badRequest("Invalid orderId")
    const gateway = parseGateway((body as any)?.gateway)
    if (!gateway) return badRequest("Invalid gateway")
    const amount = parseAmount((body as any)?.amount)
    if (amount === null) return badRequest("Invalid amount")
    const confirmOverride = (body as any)?.confirmOverride
    if (confirmOverride !== undefined && typeof confirmOverride !== "boolean") return badRequest("confirmOverride must be a boolean")
    // Manual refunds only: the admin's optional MoMo / bank reference for the money they sent by hand.
    const ref = parseManualReference((body as any)?.manualReference)
    if (!ref.ok) return badRequest("Invalid reference (max 100 characters, one line)")
    const manualReference = gateway === "manual" ? ref.value : null

    const result = await executeRefund(defaultDeps(db), {
      table: table as OrderTable, orderId, gateway, amount, adminId: userId!, confirmOverride: confirmOverride === true, manualReference,
    })
    await auditRefund(db, userId, "order_refund", { table, orderId, gateway, amount, confirmOverride: confirmOverride === true, ...(gateway === "manual" ? { manualReference } : {}), ...result })
    return NextResponse.json(result, { status: settledHttpStatus("execute", result.status) })
  } catch (err) {
    await auditRefundError(db, userId, "order_refund", err, { table: (body as any)?.table, orderId: (body as any)?.orderId })
    return refundErrorResponse(err)
  }
}
