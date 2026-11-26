import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { getWebhookSettingsAdmin, saveWebhookSettings } from "@/lib/api-v2/admin-console/webhooks"

/** GET /api/admin/api-v2/webhook-settings - the webhooks switch, endpoints set up, and today's deliveries by state. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const out = await getWebhookSettingsAdmin(getAdminClient() as RpcClient, new Date())
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}

/** PUT - body { enabled: boolean }. Recorded with the admin's id in SQL. */
export async function PUT(request: NextRequest) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null
  const out = await saveWebhookSettings(getAdminClient() as RpcClient, { enabled: body?.enabled, actorId })
  return NextResponse.json(out.body, { status: out.status })
}
