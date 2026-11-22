import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { decide, type RpcClient } from "@/lib/api-v2/approvals"

/**
 * POST /api/admin/api-v2/approvals/[id] - Admin: approve or reject one request.
 * Body: { kind: "key" | "swap" | "access", action: "approve" | "reject", reason? }. The actor is always the
 * verified admin; nothing in the body can choose it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { id } = await params
  const body = (await request.json().catch(() => null)) as { kind?: unknown; action?: unknown; reason?: unknown } | null
  const kind = body?.kind === "key" || body?.kind === "swap" ? "key" : body?.kind === "access" ? "access" : null
  const action = body?.action === "approve" || body?.action === "reject" ? body.action : null
  if (!kind || !action) return NextResponse.json({ error: "kind and action are required" }, { status: 400 })

  const reason = typeof body?.reason === "string" ? body.reason : undefined
  const out = await decide(getAdminClient() as RpcClient, { kind, action, id, actorId: userId, reason })
  return NextResponse.json(out.body, { status: out.status })
}
