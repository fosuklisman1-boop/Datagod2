import { withV2 } from "@/lib/api-v2/handler"
import { purchaseBundleHandler } from "@/lib/api-v2/endpoints/bundles"
import { realBundleDeps } from "@/lib/api-v2/endpoints/bundles-deps"
import { readJsonBody } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// buyBundle awaits the Hubtel dispatch inside the request. A function killed mid-call leaves the
// claim in_progress (it reads as OUTCOME_UNKNOWN later, never re-run), so give the engine the full 300 s.
export const maxDuration = 300

export const POST = withV2(
  {
    requiredType: "commission",
    group: "purchase",
    endpoint: "/api/v2/bundles/purchase",
    failClosedWhenLimiterDegraded: true,
  },
  async (req, ctx) => purchaseBundleHandler(realBundleDeps())(await readJsonBody(req), ctx)
)
