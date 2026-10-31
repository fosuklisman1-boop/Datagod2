import { withV2 } from "@/lib/api-v2/handler"
import { billLookupHandler } from "@/lib/api-v2/endpoints/bills"
import { realBillsDeps } from "@/lib/api-v2/endpoints/bills-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// Same bound as the v1 bills routes: the Hubtel account query runs inside the
// request, and 60 s keeps every bills request well inside the engine's
// 5-minute stuck-dispatch threshold.
export const maxDuration = 60

// A lookup moves no money, so it does not fail closed when the rate limiter is
// degraded (Upstash Redis missing or down): it must keep working without Redis.
// It still shares the purchase-group limit with /utilities/pay when Redis is up.
// /utilities/pay stays fail-closed.
export const POST = withV2(
  {
    requiredType: "commission",
    group: "purchase",
    endpoint: "/api/v2/utilities/lookup",
  },
  async (req, ctx) => billLookupHandler(realBillsDeps())(await readJsonBody(req), ctx)
)
