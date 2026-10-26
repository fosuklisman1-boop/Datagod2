import { withV2 } from "@/lib/api-v2/handler"
import { registerAfaHandler } from "@/lib/api-v2/endpoints/afa"
import { realAfaDeps } from "@/lib/api-v2/endpoints/afa-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// submitAfaOrder fires fulfillment WITHOUT awaiting it (existing engine behaviour), so the
// request itself is short. 60 s stays far below CLAIM_STALE_MS (600 s).
export const maxDuration = 60

export const POST = withV2(
  {
    requiredType: "standard",
    group: "purchase",
    endpoint: "/api/v2/afa/register",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => registerAfaHandler(realAfaDeps())(await readJsonBody(req), ctx)
)
