import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { saveAnnouncement } from "@/lib/api-v2/admin-console/announcements"

/** POST /api/admin/api-v2/announcements - create. The actor is always the verified admin. */
export async function POST(request: NextRequest) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const out = await saveAnnouncement(getAdminClient() as RpcClient, {
    id: null,
    title: b?.title as string,
    body: b?.body as string,
    severity: b?.severity as string,
    startsAt: b?.startsAt as string,
    endsAt: b?.endsAt as string,
    actorId,
  })
  return NextResponse.json(out.body, { status: out.status })
}
