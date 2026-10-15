import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { badRequest, isUuid, refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { defaultDeps, previewRefund } from "@/lib/refunds/service"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const body = await request.json().catch(() => null)
    const { table, orderId } = body ?? {}
    if (!ORDER_TABLES.includes(table as OrderTable)) return badRequest("Invalid table")
    if (!isUuid(orderId)) return badRequest("Invalid orderId")
    const preview = await previewRefund(defaultDeps(refundDb()), { table, id: orderId })
    // Customer details (name, email, phones) only for a signed-in admin: a CRON_SECRET caller passes
    // verifyAdminAccess with no user and must never receive PII.
    return NextResponse.json(userId ? preview : { ...preview, contact: null })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
