import { withV2 } from "@/lib/api-v2/handler"
import { bulkHandler } from "@/lib/api-v2/endpoints/data"
import { readJsonBody, realDataDeps } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// Up to 100 orders placed sequentially, each one atomic RPC.
export const maxDuration = 60

export const POST = withV2(
  {
    requiredType: "standard",
    group: "bulk",
    endpoint: "/api/v2/data/bulk",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => bulkHandler(realDataDeps())(await readJsonBody(req), ctx)
)
