import { withV2 } from "@/lib/api-v2/handler"
import { purchaseHandler } from "@/lib/api-v2/endpoints/data"
import { readJsonBody, realDataDeps } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export const POST = withV2(
  {
    requiredType: "standard",
    group: "purchase",
    endpoint: "/api/v2/data/purchase",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => purchaseHandler(realDataDeps())(await readJsonBody(req), ctx)
)
