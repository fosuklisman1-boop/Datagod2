import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"
import { listDeliveries } from "@/lib/api-v2/webhooks/dev"

export const dynamic = "force-dynamic"

/** GET /api/user/v2-dashboard/webhook/deliveries?cursor= - the caller's webhook events, newest first, with attempts. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_read", 120, 60_000)
  if (limited) return limited
  const out = await listDeliveries(dashboardClient(), user.id, request.nextUrl.searchParams.get("cursor"))
  return json(out.status, out.body)
}
