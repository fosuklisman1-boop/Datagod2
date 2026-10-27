import { withV2 } from "@/lib/api-v2/handler"
import { resultsOrderHandler } from "@/lib/api-v2/endpoints/results"
import { realResultsDeps } from "@/lib/api-v2/endpoints/results-deps"
import { referenceFromPath } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// The reference is read from the path: withV2 handlers receive only the request.
export const GET = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/resultschecker/orders/[reference]" },
  async (req, ctx) => resultsOrderHandler(realResultsDeps())(referenceFromPath(req.nextUrl.pathname), ctx)
)
