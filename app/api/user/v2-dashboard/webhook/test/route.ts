import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"
import { sendTestEvent } from "@/lib/api-v2/webhooks/dev"
import { realDevDeps } from "@/lib/api-v2/webhooks/dev-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 30

/** POST /api/user/v2-dashboard/webhook/test - send one signed webhook.test event now and report what came back. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_webhook_test", 10, 10 * 60_000)
  if (limited) return limited
  const out = await sendTestEvent(dashboardClient(), user.id, realDevDeps)
  return json(out.status, out.body)
}
