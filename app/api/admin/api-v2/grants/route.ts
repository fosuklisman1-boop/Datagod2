import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { listGrants } from "@/lib/api-v2/approvals"

/** GET /api/admin/api-v2/grants?page= - Admin: people with an API-only access grant. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const n = Number(new URL(request.url).searchParams.get("page"))
  const result = await listGrants(getAdminClient(), Number.isInteger(n) && n > 0 ? n : 0)
  if (result === "error") return NextResponse.json({ error: "Could not load grants. Please try again." }, { status: 500 })
  return NextResponse.json(result)
}
