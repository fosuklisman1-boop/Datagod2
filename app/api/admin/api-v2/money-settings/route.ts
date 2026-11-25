import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import type { RpcClient } from "@/lib/api-v2/approvals"
import { getMoneySettingsAdmin, saveMoneySettings } from "@/lib/api-v2/admin-console/money"

/** GET /api/admin/api-v2/money-settings - the two switches, the risk thresholds and today's alert count. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const out = await getMoneySettingsAdmin(getAdminClient() as RpcClient, new Date())
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } })
}

/** PUT - body { capsEnabled?, alertsEnabled?, thresholds? }. Left-out fields stay as they are; audited in SQL. */
export async function PUT(request: NextRequest) {
  const { isAdmin, userId: actorId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const body = (await request.json().catch(() => null)) as { capsEnabled?: unknown; alertsEnabled?: unknown; thresholds?: unknown } | null
  const out = await saveMoneySettings(getAdminClient() as RpcClient, {
    capsEnabled: body?.capsEnabled,
    alertsEnabled: body?.alertsEnabled,
    thresholds: body?.thresholds,
    actorId,
  })
  return NextResponse.json(out.body, { status: out.status })
}
