import { withV2 } from "@/lib/api-v2/handler"
import { afaOrderHandler } from "@/lib/api-v2/endpoints/afa"
import { realAfaDeps } from "@/lib/api-v2/endpoints/afa-deps"
import { referenceFromPath } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// The reference is read from the path: withV2 handlers receive only the request.
export const GET = withV2(
  { requiredType: "standard", group: "status", endpoint: "/api/v2/afa/orders/[reference]" },
  async (req, ctx) => afaOrderHandler(realAfaDeps())(referenceFromPath(req.nextUrl.pathname), ctx)
)
