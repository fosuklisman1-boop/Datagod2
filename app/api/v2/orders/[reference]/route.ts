import { withV2 } from "@/lib/api-v2/handler"
import { orderLookupHandler } from "@/lib/api-v2/endpoints/data"
import { realDataDeps, referenceFromPath } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// The reference is read from the path: withV2 handlers receive only the request.
export const GET = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/orders/[reference]" },
  async (req, ctx) => orderLookupHandler(realDataDeps())(referenceFromPath(req.nextUrl.pathname), ctx)
)
