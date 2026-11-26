import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"
import { revealSecret, rotateSecret } from "@/lib/api-v2/webhooks/dev"
import { realDevDeps } from "@/lib/api-v2/webhooks/dev-deps"

export const dynamic = "force-dynamic"

/** GET /api/user/v2-dashboard/webhook/secret - reveal the signing secret (session only, rate-limited). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_webhook_reveal", 30, 60 * 60_000)
  if (limited) return limited
  const out = await revealSecret(dashboardClient(), user.id)
  return json(out.status, out.body)
}

/** POST - rotate: a new secret takes effect at once and is returned once. */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_webhook_write", 20, 60 * 60_000)
  if (limited) return limited
  const out = await rotateSecret(dashboardClient(), user.id, realDevDeps)
  return json(out.status, out.body)
}
