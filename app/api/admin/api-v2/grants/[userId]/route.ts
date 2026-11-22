import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { removeGrant, type RpcClient } from "@/lib/api-v2/approvals"

/** DELETE /api/admin/api-v2/grants/[userId] - Admin: remove a person's API-only grant. Body: { reason }. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { userId } = await params
  const body = (await request.json().catch(() => null)) as { reason?: unknown } | null
  const reason = typeof body?.reason === "string" ? body.reason : ""
  const out = await removeGrant(getAdminClient() as RpcClient, { userId, actorId: adminId, reason })
  return NextResponse.json(out.body, { status: out.status })
}
