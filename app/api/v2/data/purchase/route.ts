import { withV2 } from "@/lib/api-v2/handler"
import { purchaseHandler } from "@/lib/api-v2/endpoints/data"
import { readJsonBody, realDataDeps } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
// The provider dispatch runs AFTER the response via after(), but inside this
// same function budget: one MTN createMTNOrder chain (retry sequence across
// providers) can take 30 s or more. 300 s keeps a paid order from being cut
// off before it reaches a provider.
export const maxDuration = 300

export const POST = withV2(
  {
    requiredType: "standard",
    group: "purchase",
    endpoint: "/api/v2/data/purchase",
    fallbackLimitWhenDegraded: true,
  },
  async (req, ctx) => purchaseHandler(realDataDeps())(await readJsonBody(req), ctx)
)
