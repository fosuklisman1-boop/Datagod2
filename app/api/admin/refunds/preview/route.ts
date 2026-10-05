import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { badRequest, isUuid, refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { defaultDeps, previewRefund } from "@/lib/refunds/service"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const body = await request.json().catch(() => null)
    const { table, orderId } = body ?? {}
    if (!ORDER_TABLES.includes(table as OrderTable)) return badRequest("Invalid table")
    if (!isUuid(orderId)) return badRequest("Invalid orderId")
    return NextResponse.json(await previewRefund(defaultDeps(refundDb()), { table, id: orderId }))
  } catch (err) {
    return refundErrorResponse(err)
  }
}
