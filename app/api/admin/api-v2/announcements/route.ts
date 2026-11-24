import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { listAnnouncements, saveAnnouncement } from "@/lib/api-v2/admin-console/announcements"

/** GET /api/admin/api-v2/announcements - Admin: every announcement with its state (active, scheduled, ended). */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const out = await listAnnouncements(getAdminClient() as RpcClient, new Date())
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}

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
