import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { deleteAnnouncement, saveAnnouncement } from "@/lib/api-v2/admin-console/announcements"

/** PUT /api/admin/api-v2/announcements/[id] - edit. The actor is always the verified admin. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const out = await saveAnnouncement(getAdminClient() as RpcClient, {
    id,
    title: b?.title as string,
    body: b?.body as string,
    severity: b?.severity as string,
    startsAt: b?.startsAt as string,
    endsAt: b?.endsAt as string,
    actorId,
  })
  return NextResponse.json(out.body, { status: out.status })
}

/** DELETE /api/admin/api-v2/announcements/[id] */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const out = await deleteAnnouncement(getAdminClient() as RpcClient, { id, actorId })
  return NextResponse.json(out.body, { status: out.status })
}
