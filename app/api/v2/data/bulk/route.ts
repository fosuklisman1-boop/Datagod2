import { withV2 } from "@/lib/api-v2/handler"
import { bulkHandler } from "@/lib/api-v2/endpoints/data"
import { readJsonBody, realDataDeps } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// Up to 100 orders placed sequentially (each one atomic RPC), stopping new
// placements at BULK_DEADLINE_MS (25 s). The provider dispatch for every
// placed order then runs via ONE after() callback (4 in flight) inside this
// same function budget, and one MTN provider call can take 30 s, so the
// budget is the 300 s maximum rather than 60 s.
export const maxDuration = 300

export const POST = withV2(
  {
    requiredType: "standard",
    group: "bulk",
    endpoint: "/api/v2/data/bulk",
    fallbackLimitWhenDegraded: true,
  },
  async (req, ctx) => bulkHandler(realDataDeps())(await readJsonBody(req), ctx)
)
