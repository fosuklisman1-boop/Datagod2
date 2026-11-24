import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { getDeveloperProfile } from "@/lib/api-v2/admin-console/developers"

/** GET /api/admin/api-v2/developers/[userId] - Admin: one developer's profile (phones masked to the last 4). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { userId } = await params
  const out = await getDeveloperProfile(getAdminClient() as RpcClient, userId, new Date())
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}
