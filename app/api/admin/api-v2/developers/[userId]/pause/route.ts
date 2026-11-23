import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { setDeveloperPause } from "@/lib/api-v2/admin-console/developers"

/** POST /api/admin/api-v2/developers/[userId]/pause - body { paused, reason }. The actor is always the verified admin. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { userId } = await params
  const body = (await request.json().catch(() => null)) as { paused?: unknown; reason?: unknown } | null
  const out = await setDeveloperPause(getAdminClient() as RpcClient, {
    userId,
    paused: body?.paused as boolean,
    reason: typeof body?.reason === "string" ? body.reason : "",
    actorId,
  })
  return NextResponse.json(out.body, { status: out.status })
}
