import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { loadTrend } from "@/lib/api-v2/admin-console/report"

/** GET /api/admin/api-v2/trend?days=7|30|90 - Admin: per-day requests, failures and data revenue. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const out = await loadTrend(getAdminClient() as RpcClient, new URL(request.url).searchParams, new Date())
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}
