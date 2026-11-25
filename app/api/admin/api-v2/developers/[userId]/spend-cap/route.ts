import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { getDeveloperSpend, setAdminCap } from "@/lib/api-v2/admin-console/money"

/** GET /api/admin/api-v2/developers/[userId]/spend-cap - today's spend against each limit, refusals and recent alerts. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { userId } = await params
  const out = await getDeveloperSpend(getAdminClient() as RpcClient, userId)
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}

/** PUT - body { cap } (GHS, or null/"" to remove). Sets the admin per-person daily limit; the actor is the verified admin. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { userId } = await params
  const body = (await request.json().catch(() => null)) as { cap?: unknown } | null
  const out = await setAdminCap(getAdminClient() as RpcClient, { userId, cap: body && "cap" in body ? body.cap : undefined, actorId })
  return NextResponse.json(out.body, { status: out.status })
}
