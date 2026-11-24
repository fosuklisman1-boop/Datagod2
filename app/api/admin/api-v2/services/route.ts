import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { listServices } from "@/lib/api-v2/admin-console/services"

/** GET /api/admin/api-v2/services - Admin: the seven services and their pause state. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const out = await listServices(getAdminClient() as RpcClient)
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}
