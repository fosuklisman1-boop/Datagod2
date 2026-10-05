import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { badRequest, isUuid, loadStoredRefund, refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { inspectGatewayStatus } from "@/lib/refunds/gateway-status"
import { defaultDeps } from "@/lib/refunds/service"

/** Read-only: asks the gateway what it thinks of this refund. Never settles or writes anything. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    if (!isUuid(id)) return badRequest("Invalid refund id")
    const db = refundDb()
    const stored = await loadStoredRefund(db, id)
    return NextResponse.json(await inspectGatewayStatus(defaultDeps(db), stored))
  } catch (err) {
    return refundErrorResponse(err)
  }
}
