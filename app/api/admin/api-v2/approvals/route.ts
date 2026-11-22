import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { listApprovals, type RpcClient } from "@/lib/api-v2/approvals"

/** GET /api/admin/api-v2/approvals?q=&page= - Admin: pending live-key and access requests, oldest first. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const params = new URL(request.url).searchParams
  const q = (params.get("q") ?? "").slice(0, 100)
  const n = Number(params.get("page"))
  const result = await listApprovals(getAdminClient() as RpcClient, { q, page: Number.isInteger(n) && n > 0 ? n : 0 })
  if (result === "error") return NextResponse.json({ error: "Could not load approvals. Please try again." }, { status: 500 })
  return NextResponse.json(result)
}
