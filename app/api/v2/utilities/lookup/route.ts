import { withV2 } from "@/lib/api-v2/handler"
import { billLookupHandler } from "@/lib/api-v2/endpoints/bills"
import { realBillsDeps } from "@/lib/api-v2/endpoints/bills-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// Same bound as the v1 bills routes: the Hubtel account query runs inside the
// request, and 60 s keeps every bills request well inside the engine's
// 5-minute stuck-dispatch threshold.
export const maxDuration = 60

export const POST = withV2(
  {
    requiredType: "commission",
    group: "purchase",
    endpoint: "/api/v2/utilities/lookup",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => billLookupHandler(realBillsDeps())(await readJsonBody(req), ctx)
)
