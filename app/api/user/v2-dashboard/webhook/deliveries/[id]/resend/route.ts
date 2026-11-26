import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"
import { resendDelivery } from "@/lib/api-v2/webhooks/dev"

export const dynamic = "force-dynamic"

/** POST /api/user/v2-dashboard/webhook/deliveries/{id}/resend - queue a delivered or failed event again. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_webhook_resend", 30, 60 * 60_000)
  if (limited) return limited
  const { id } = await ctx.params
  const out = await resendDelivery(dashboardClient(), user.id, id)
  return json(out.status, out.body)
}
