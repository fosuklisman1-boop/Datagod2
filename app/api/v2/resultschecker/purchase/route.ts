import { withV2 } from "@/lib/api-v2/handler"
import { purchaseResultsHandler } from "@/lib/api-v2/endpoints/results"
import { realResultsDeps } from "@/lib/api-v2/endpoints/results-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// The engine and the recipient delivery (SMS/email) run inside the request. A function killed
// mid-call leaves the claim in_progress (it reads as OUTCOME_UNKNOWN later, never re-run).
// 300 s stays below CLAIM_STALE_MS (600 s), so a live request is never read as stale.
export const maxDuration = 300

export const POST = withV2(
  {
    requiredType: "standard",
    group: "purchase",
    endpoint: "/api/v2/resultschecker/purchase",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => purchaseResultsHandler(realResultsDeps())(await readJsonBody(req), ctx)
)
