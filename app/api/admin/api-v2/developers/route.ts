import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { listDevelopers } from "@/lib/api-v2/admin-console/developers"

/** GET /api/admin/api-v2/developers?q=&page= - Admin: everyone with v2 keys, 30-day usage, 25 per page. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const sp = new URL(request.url).searchParams
  const out = await listDevelopers(getAdminClient() as RpcClient, { q: sp.get("q"), page: Number.parseInt(sp.get("page") ?? "0", 10), now: new Date() })
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}
