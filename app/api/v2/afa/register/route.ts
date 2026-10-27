import { withV2 } from "@/lib/api-v2/handler"
import { registerAfaHandler } from "@/lib/api-v2/endpoints/afa"
import { realAfaDeps } from "@/lib/api-v2/endpoints/afa-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// submitAfaOrder fires fulfillment WITHOUT awaiting it (existing engine behaviour), but it does
// await the confirmation SMS and the admin alert, each with provider fallback. A function killed
// mid-call leaves the claim in_progress (it reads as OUTCOME_UNKNOWN later, never re-run), so give
// the engine the full 300 s. 300 s stays below CLAIM_STALE_MS (600 s), which a test pins.
export const maxDuration = 300

export const POST = withV2(
  {
    requiredType: "standard",
    group: "purchase",
    endpoint: "/api/v2/afa/register",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => registerAfaHandler(realAfaDeps())(await readJsonBody(req), ctx)
)
