import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { setServicePause } from "@/lib/api-v2/admin-console/services"

/** PUT /api/admin/api-v2/services/[service] - body { paused, message }. The actor is always the verified admin. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ service: string }> }) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { service } = await params
  const body = (await request.json().catch(() => null)) as { paused?: unknown; message?: unknown } | null
  const out = await setServicePause(getAdminClient() as RpcClient, {
    service,
    paused: body?.paused as boolean,
    message: (body?.message ?? null) as string | null,
    actorId,
  })
  return NextResponse.json(out.body, { status: out.status })
}
