import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"
import { deleteWebhook, getWebhook, saveWebhook } from "@/lib/api-v2/webhooks/dev"
import { realDevDeps } from "@/lib/api-v2/webhooks/dev-deps"

export const dynamic = "force-dynamic"

/** GET /api/user/v2-dashboard/webhook - the caller's webhook endpoint (no secret) and whether webhooks are switched on. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_read", 120, 60_000)
  if (limited) return limited
  const out = await getWebhook(dashboardClient(), user.id)
  return json(out.status, out.body)
}

/** PUT - body { url, enabled? }. Creating returns the signing secret once. */
export async function PUT(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_webhook_write", 20, 60 * 60_000)
  if (limited) return limited
  const body = await request.json().catch(() => null)
  const out = await saveWebhook(dashboardClient(), user.id, body, realDevDeps)
  return json(out.status, out.body)
}

/** DELETE - removes the endpoint; queued events are marked failed. */
export async function DELETE(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_webhook_write", 20, 60 * 60_000)
  if (limited) return limited
  const out = await deleteWebhook(dashboardClient(), user.id)
  return json(out.status, out.body)
}
