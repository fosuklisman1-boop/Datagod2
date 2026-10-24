import { withV2 } from "@/lib/api-v2/handler"
import { airtimeOrderHandler } from "@/lib/api-v2/endpoints/airtime"
import { realAirtimeDeps } from "@/lib/api-v2/endpoints/airtime-deps"
import { referenceFromPath } from "@/lib/api-v2/endpoints/data-deps"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// The reference is read from the path: withV2 handlers receive only the request.
export const GET = withV2(
  { requiredType: "commission", group: "status", endpoint: "/api/v2/airtime/orders/[reference]" },
  async (req, ctx) => airtimeOrderHandler(realAirtimeDeps())(referenceFromPath(req.nextUrl.pathname), ctx)
)
