import type { NextRequest } from "next/server"
import { requireCapability } from "@/lib/roles/require-capability"
import { lookupOrder, type LookupTable } from "@/lib/api-v2/dashboard-order-lookup"
import { dashboardClient, getSessionUser, json, readLimited, unauthorized } from "@/lib/api-v2/dashboard-session"
import { orderLookupHandler } from "@/lib/api-v2/endpoints/data"
import { realDataDeps } from "@/lib/api-v2/endpoints/data-deps"
import { airtimeOrderHandler } from "@/lib/api-v2/endpoints/airtime"
import { realAirtimeDeps } from "@/lib/api-v2/endpoints/airtime-deps"
import { billOrderHandler } from "@/lib/api-v2/endpoints/bills"
import { realBillsDeps } from "@/lib/api-v2/endpoints/bills-deps"
import { bundleOrderHandler } from "@/lib/api-v2/endpoints/bundles"
import { realBundleDeps } from "@/lib/api-v2/endpoints/bundles-deps"
import { resultsOrderHandler } from "@/lib/api-v2/endpoints/results"
import { realResultsDeps } from "@/lib/api-v2/endpoints/results-deps"
import { afaOrderHandler } from "@/lib/api-v2/endpoints/afa"
import { realAfaDeps } from "@/lib/api-v2/endpoints/afa-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const TABLE: LookupTable = {
  data: () => orderLookupHandler(realDataDeps()),
  airtime: () => airtimeOrderHandler(realAirtimeDeps()),
  bill: () => billOrderHandler(realBillsDeps()),
  bundle: () => bundleOrderHandler(realBundleDeps()),
  results: () => resultsOrderHandler(realResultsDeps()),
  afa: () => afaOrderHandler(realAfaDeps()),
}

/** GET /api/user/v2-dashboard/orders/[product]/[reference] - one of the caller's own live orders, status read now. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ product: string; reference: string }> }) {
  const user = await getSessionUser(request)
  if (!user) return unauthorized()
  const refused = await requireCapability(dashboardClient(), user.id, "account.api")
  if (refused) return refused
  const limited = await readLimited(request, user.id, "v2_dashboard_read", 120, 60_000)
  if (limited) return limited
  const { product, reference } = await params
  let ref: string
  try {
    ref = decodeURIComponent(reference)
  } catch {
    return json(404, { error: "Order not found" })
  }
  const r = await lookupOrder(product, ref, user.id, TABLE)
  return r.error ? json(r.status, { error: r.error.message }) : json(r.status, r.data ?? {})
}
